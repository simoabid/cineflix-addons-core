/**
 * Import addons from "the internet" — an addon repository / community list.
 *
 * A repository is any URL that returns a list of addon manifest / transport
 * URLs. We accept several common shapes so users can point at whatever list
 * they find:
 *   - JSON array of strings:            ["https://a/manifest.json", ...]
 *   - JSON array of objects:            [{ "transportUrl": "..." }, { "url": "..." }]
 *   - JSON object with an addons array: { "addons": [{ "transportUrl": "..." }] }
 *   - Stremio collection descriptors:   [{ "transportUrl", "manifest", "flags" }]
 *   - Plain text: one URL per line (# comments allowed)
 *
 * Fetches go through secureFetch (SSRF, size, redirect, content-type policy).
 */
import type { AddonManager, InstallResult } from '../addons/manager.js';
import { secureFetch } from '../security/secureFetch.js';
import { redactUrl } from '../security/redaction.js';
import type { UrlPolicyOptions } from '../security/urlPolicy.js';
import type { AppConfig } from '../config.js';

function extractUrlsFromJson(json: unknown): string[] {
    const urls: string[] = [];

    const pushFromEntry = (entry: unknown): void => {
        if (typeof entry === 'string') {
            urls.push(entry);
            return;
        }
        if (entry && typeof entry === 'object') {
            const o = entry as Record<string, unknown>;
            const candidate =
                (typeof o.transportUrl === 'string' && o.transportUrl) ||
                (typeof o.url === 'string' && o.url) ||
                (typeof o.manifestUrl === 'string' && o.manifestUrl) ||
                (typeof o.manifest === 'string' && o.manifest);
            if (candidate) urls.push(candidate);
        }
    };

    if (Array.isArray(json)) {
        json.forEach(pushFromEntry);
    } else if (json && typeof json === 'object') {
        const o = json as Record<string, unknown>;
        const arr =
            (Array.isArray(o.addons) && o.addons) ||
            (Array.isArray(o.items) && o.items) ||
            (Array.isArray(o.results) && o.results) ||
            null;
        if (arr) arr.forEach(pushFromEntry);
    }

    return urls;
}

function extractUrlsFromText(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .filter((l) => /^(https?:\/\/|stremio:\/\/)/i.test(l));
}

/** Parse whatever a repository URL returns into a list of addon URLs. */
export function parseRepositoryPayload(
    raw: string,
    contentType = ''
): string[] {
    const looksJson =
        contentType.includes('json') ||
        raw.trim().startsWith('[') ||
        raw.trim().startsWith('{');
    if (looksJson) {
        try {
            const parsed = JSON.parse(raw);
            const urls = extractUrlsFromJson(parsed);
            if (urls.length) return dedupe(urls);
        } catch {
            /* fall through to text parsing */
        }
    }
    return dedupe(extractUrlsFromText(raw));
}

function dedupe(urls: string[]): string[] {
    return [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
}

function isValidRepositoryJson(json: unknown): boolean {
    if (Array.isArray(json)) {
        return json.every(
            (e) =>
                typeof e === 'string' ||
                (e &&
                    typeof e === 'object' &&
                    ('transportUrl' in (e as object) ||
                        'url' in (e as object) ||
                        'manifestUrl' in (e as object)))
        );
    }
    if (json && typeof json === 'object') {
        const o = json as Record<string, unknown>;
        const arr =
            (Array.isArray(o.addons) && o.addons) ||
            (Array.isArray(o.items) && o.items) ||
            (Array.isArray(o.results) && o.results);
        if (arr) {
            return arr.every(
                (e) =>
                    typeof e === 'string' ||
                    (e &&
                        typeof e === 'object' &&
                        ('transportUrl' in (e as object) ||
                            'url' in (e as object) ||
                            'manifestUrl' in (e as object)))
            );
        }
        // Single object with URL fields? treat as invalid for repository (should be array)
        return false;
    }
    return false;
}

export interface RepositoryImportResult {
    installed: number;
    failed: number;
    total: number;
    discovered: number;
    results: InstallResult[];
}

export interface RepositoryImportOptions {
    cfg?: AppConfig;
    policy?: UrlPolicyOptions;
    maxBytes?: number;
    timeoutMs?: number;
    maxUrls?: number;
    signal?: AbortSignal;
}

export async function importFromRepository(
    manager: AddonManager,
    repositoryUrl: string,
    options: RepositoryImportOptions = {}
): Promise<RepositoryImportResult> {
    const maxBytes =
        options.maxBytes ?? options.cfg?.importMaxBytes ?? 1_048_576;
    const timeoutMs =
        options.timeoutMs ?? options.cfg?.importTimeoutMs ?? 20_000;
    const maxUrls = options.maxUrls ?? options.cfg?.importMaxUrls ?? 50;
    const policy: UrlPolicyOptions = options.policy ?? {
        allowHttp: options.cfg?.allowHttpUpstreams ?? false,
        hostAllowlist:
            options.cfg && options.cfg.outboundHostAllowlist.length > 0
                ? options.cfg.outboundHostAllowlist
                : undefined,
        allowHostSuffixes: options.cfg?.outboundHostAllowSuffixes
    };

    if (options.signal?.aborted) {
        throw Object.assign(new Error('Import cancelled'), { code: 'CANCELLED', name: 'AbortError' });
    }
    const result = await secureFetch(repositoryUrl, {
        headers: { Accept: 'application/json, text/plain, */*' },
        timeoutMs,
        maxBytes,
        maxRedirects: 3,
        policy,
        viaProxy: 'auto',
        signal: options.signal
    });

    if (!result.response.ok) {
        throw new Error(
            `Repository fetch failed: HTTP ${result.response.status} for ${redactUrl(repositoryUrl)}`
        );
    }
    const contentType = (
        result.response.headers.get('content-type') ?? ''
    ).toLowerCase();
    // Strict content-type enforcement: must be json or text
    if (
        contentType &&
        !/(json|text\/plain|text\/html|application\/octet-stream)/.test(
            contentType
        )
    ) {
        throw new Error(
            `Repository unexpected content-type '${contentType}' (expected JSON or text)`
        );
    }
    const raw = await result.response.text();
    if (raw.length > maxBytes) {
        throw new Error(
            `Repository payload exceeds size limit (${maxBytes} bytes)`
        );
    }
    // Strict schema validation when JSON: must contain an array of URL strings or objects with transportUrl/url fields
    if (
        contentType.includes('json') ||
        raw.trim().startsWith('[') ||
        raw.trim().startsWith('{')
    ) {
        try {
            const parsed = JSON.parse(raw);
            const valid = isValidRepositoryJson(parsed);
            if (!valid) {
                throw new Error(
                    'Repository JSON does not match expected schema (array of URLs or { addons: [...] })'
                );
            }
        } catch (err) {
            if (err instanceof SyntaxError) {
                throw new Error(`Repository JSON parse error: ${err.message}`);
            }
            throw err;
        }
    }
    let urls = parseRepositoryPayload(raw, contentType);

    if (urls.length === 0) {
        throw new Error('No addon URLs found in repository payload');
    }

    const discovered = urls.length;
    if (urls.length > maxUrls) {
        urls = urls.slice(0, maxUrls);
    }

    if (options.signal?.aborted) {
        throw Object.assign(new Error('Import cancelled'), { code: 'CANCELLED', name: 'AbortError' });
    }
    const results = await manager.installMany(urls, 'repository', { signal: options.signal });
    const installed = results.filter((r) => r.ok).length;
    return {
        installed,
        failed: results.length - installed,
        total: results.length,
        discovered,
        results
    };
}
