/**
 * Low-level Stremio addon HTTP client.
 *
 * Talks the Stremio Addon Protocol over HTTP:
 *   {base}/manifest.json
 *   {base}/stream/{type}/{id}.json
 *   {base}/subtitles/{type}/{id}.json
 *
 * All fetches go through secureFetch (SSRF, DNS pinning, redirect, size policy).
 */
import { secureFetch } from '../security/secureFetch.js';
import { type UrlPolicyOptions } from '../security/urlPolicy.js';
import { redactUrl } from '../security/redaction.js';
import type {
    StremioManifest,
    StremioStream,
    StremioStreamResponse,
    StremioSubtitle,
    StremioSubtitleResponse
} from './protocol.js';

const DEFAULT_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json'
};

export class StremioAddonError extends Error {
    constructor(
        message: string,
        readonly url?: string
    ) {
        super(message);
        this.name = 'StremioAddonError';
    }
}

/**
 * Normalise any user-supplied addon reference into a canonical
 * `{ manifestUrl, baseUrl, originalUrl }`. Accepts:
 *   - https://host/path/manifest.json
 *   - https://host/path            (assumed base; /manifest.json appended)
 *   - stremio://host/path/manifest.json
 *
 * Query strings are preserved on both base and manifest URLs so
 * configuration-bearing transport URLs are not silently stripped.
 */
export function normalizeAddonUrl(input: string): {
    manifestUrl: string;
    baseUrl: string;
    originalUrl: string;
} {
    let raw = input.trim();
    if (!raw) throw new StremioAddonError('Empty addon URL');
    const originalUrl = raw;

    if (raw.startsWith('stremio://')) {
        raw = 'https://' + raw.slice('stremio://'.length);
    }
    if (!/^https?:\/\//i.test(raw)) {
        raw = 'https://' + raw;
    }

    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new StremioAddonError(`Invalid addon URL: ${input}`);
    }

    let path = u.pathname.replace(/\/+$/, '');
    if (path.toLowerCase().endsWith('/manifest.json')) {
        path = path.slice(0, -'/manifest.json'.length);
    } else if (path.toLowerCase() === '/manifest.json') {
        path = '';
    }

    const baseUrl = `${u.origin}${path}${u.search}`;
    const manifestUrl = `${u.origin}${path}/manifest.json${u.search}`;
    return { manifestUrl, baseUrl, originalUrl };
}

/** Split a base URL into origin+path and a preserved query string. */
function splitBase(baseUrl: string): { root: string; query: string } {
    const qIndex = baseUrl.indexOf('?');
    if (qIndex === -1) return { root: baseUrl.replace(/\/+$/, ''), query: '' };
    return {
        root: baseUrl.slice(0, qIndex).replace(/\/+$/, ''),
        query: baseUrl.slice(qIndex)
    };
}

export interface FetchManifestOptions {
    maxBytes?: number;
    policy?: UrlPolicyOptions;
    signal?: AbortSignal;
}

export async function fetchManifest(
    addonUrl: string,
    timeoutMs = 15_000,
    options: FetchManifestOptions = {}
): Promise<{
    manifest: StremioManifest;
    baseUrl: string;
    manifestUrl: string;
    originalUrl: string;
}> {
    const { manifestUrl, baseUrl, originalUrl } = normalizeAddonUrl(addonUrl);

    const result = await secureFetch(manifestUrl, {
        headers: DEFAULT_HEADERS,
        timeoutMs,
        maxBytes: options.maxBytes ?? 1_048_576,
        maxRedirects: 3,
        acceptContentTypes: ['json', 'text/plain', 'javascript'],
        policy: options.policy ?? { allowHttp: false },
        viaProxy: 'auto',
        signal: options.signal
    });

    if (!result.response.ok) {
        throw new StremioAddonError(
            `Manifest HTTP ${result.response.status} for ${redactUrl(manifestUrl)}`,
            redactUrl(manifestUrl)
        );
    }

    let manifest: StremioManifest;
    try {
        manifest = (await result.response.json()) as StremioManifest;
    } catch {
        throw new StremioAddonError(
            `Manifest is not valid JSON: ${redactUrl(manifestUrl)}`,
            redactUrl(manifestUrl)
        );
    }
    if (!manifest || typeof manifest !== 'object' || !manifest.id) {
        throw new StremioAddonError(
            `Manifest missing required 'id': ${redactUrl(manifestUrl)}`,
            redactUrl(manifestUrl)
        );
    }
    return {
        manifest,
        baseUrl,
        manifestUrl: result.finalUrl || manifestUrl,
        originalUrl
    };
}

export interface FetchStreamsOptions {
    timeoutMs?: number;
    policy?: UrlPolicyOptions;
    maxBytes?: number;
    maxRedirects?: number;
}

export async function fetchStreams(
    baseUrl: string,
    type: string,
    id: string,
    timeoutMs = 20_000,
    options: FetchStreamsOptions = {}
): Promise<StremioStream[]> {
    const { root, query } = splitBase(baseUrl);
    const url = `${root}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json${query}`;
    const policy = options.policy ?? { allowHttp: true };
    // Use full outbound policy (DNS, HTTPS, redirects, size) — not just syntax check.
    // Installed bases were validated at install time, but redirects and rebinding still need checks.
    try {
        const result = await secureFetch(url, {
            headers: DEFAULT_HEADERS,
            timeoutMs: options.timeoutMs ?? timeoutMs,
            maxBytes: options.maxBytes ?? 1_048_576,
            maxRedirects: options.maxRedirects ?? 3,
            acceptContentTypes: ['json', 'text/plain', 'javascript'],
            policy,
            viaProxy: 'auto'
        });
        if (!result.response.ok) {
            throw new StremioAddonError(
                `Stream HTTP ${result.response.status}`,
                redactUrl(url)
            );
        }
        const json = (await result.response.json()) as StremioStreamResponse;
        return Array.isArray(json?.streams) ? json.streams : [];
    } catch (err) {
        if (err instanceof StremioAddonError) throw err;
        // Wrap policy errors as StremioAddonError for uniform handling
        throw new StremioAddonError(
            err instanceof Error ? err.message : 'Failed to fetch streams',
            redactUrl(url)
        );
    }
}

export interface FetchSubtitlesOptions {
    timeoutMs?: number;
    policy?: UrlPolicyOptions;
    maxBytes?: number;
    maxRedirects?: number;
}

export async function fetchSubtitles(
    baseUrl: string,
    type: string,
    id: string,
    timeoutMs = 12_000,
    options: FetchSubtitlesOptions = {}
): Promise<StremioSubtitle[]> {
    const { root, query } = splitBase(baseUrl);
    const url = `${root}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json${query}`;
    const policy = options.policy ?? { allowHttp: true };
    try {
        const result = await secureFetch(url, {
            headers: DEFAULT_HEADERS,
            timeoutMs: options.timeoutMs ?? timeoutMs,
            maxBytes: options.maxBytes ?? 512_000,
            maxRedirects: options.maxRedirects ?? 3,
            acceptContentTypes: ['json', 'text/plain', 'javascript'],
            policy,
            viaProxy: 'auto'
        });
        if (!result.response.ok) return [];
        const json = (await result.response.json()) as StremioSubtitleResponse;
        return Array.isArray(json?.subtitles) ? json.subtitles : [];
    } catch {
        return [];
    }
}
