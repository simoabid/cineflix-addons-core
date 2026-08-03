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
 * Repository hosts are arbitrary, so the fetch goes through the egress proxy.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
import type { AddonManager, InstallResult } from '../addons/manager.js';

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

export interface RepositoryImportResult {
    installed: number;
    failed: number;
    total: number;
    discovered: number;
    results: InstallResult[];
}

export async function importFromRepository(
    manager: AddonManager,
    repositoryUrl: string
): Promise<RepositoryImportResult> {
    const res = await scrapeFetch(repositoryUrl, {
        headers: { Accept: 'application/json, text/plain, */*' },
        timeoutMs: 20_000
    });
    if (!res.ok) {
        throw new Error(
            `Repository fetch failed: HTTP ${res.status} for ${repositoryUrl}`
        );
    }
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const urls = parseRepositoryPayload(raw, contentType);

    if (urls.length === 0) {
        throw new Error('No addon URLs found in repository payload');
    }

    const results = await manager.installMany(urls, 'repository');
    const installed = results.filter((r) => r.ok).length;
    return {
        installed,
        failed: results.length - installed,
        total: results.length,
        discovered: urls.length,
        results
    };
}
