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
import { parseAddonUrl, buildResourceUrl } from './url.js';
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
    try {
        const parsed = parseAddonUrl(input);
        return {
            manifestUrl: parsed.manifestUrl,
            baseUrl: parsed.baseUrl,
            originalUrl: parsed.original
        };
    } catch (err) {
        throw new StremioAddonError(err instanceof Error ? err.message : `Invalid addon URL: ${input}`);
    }
}

/** Split a base URL into origin+path and a preserved query string — delegates to structured parser. */
// Exported for backwards compat; callers should use buildResourceUrl instead.
export function splitBase(baseUrl: string): { root: string; query: string } {
    try {
        const u = new URL(baseUrl);
        return { root: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, query: u.search };
    } catch {
        const qIndex = baseUrl.indexOf('?');
        if (qIndex === -1) return { root: baseUrl.replace(/\/+$/, ''), query: '' };
        return {
            root: baseUrl.slice(0, qIndex).replace(/\/+$/, ''),
            query: baseUrl.slice(qIndex)
        };
    }
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
    signal?: AbortSignal;
}

export async function fetchStreams(
    baseUrl: string,
    type: string,
    id: string,
    timeoutMs = 20_000,
    options: FetchStreamsOptions = {}
): Promise<StremioStream[] & { cacheMaxAge?: number }> {
    const url = buildResourceUrl(baseUrl, 'stream', type, id);
    const policy = options.policy ?? { allowHttp: true };
    if (options.signal?.aborted) throw new StremioAddonError('Aborted', redactUrl(url));
    try {
        const result = await secureFetch(url, {
            headers: DEFAULT_HEADERS,
            timeoutMs: options.timeoutMs ?? timeoutMs,
            maxBytes: options.maxBytes ?? 1_048_576,
            maxRedirects: options.maxRedirects ?? 3,
            acceptContentTypes: ['json', 'text/plain', 'javascript'],
            policy,
            viaProxy: 'auto',
            signal: options.signal
        });
        if (!result.response.ok) {
            throw new StremioAddonError(
                `Stream HTTP ${result.response.status}`,
                redactUrl(url)
            );
        }
        const json = (await result.response.json()) as StremioStreamResponse & { cacheMaxAge?: number };
        const streams = Array.isArray(json?.streams) ? json.streams : [];
        // Preserve response-level cacheMaxAge for source expiry (standard Stremio field)
        const cacheMaxAge = typeof json?.cacheMaxAge === 'number' ? json.cacheMaxAge : undefined;
        // Attach as non-enumerable expiring hint so callers can use it without changing array shape
        if (cacheMaxAge != null) {
            Object.defineProperty(streams, 'cacheMaxAge', {
                value: cacheMaxAge,
                enumerable: false,
                writable: true
            });
        }
        return streams as StremioStream[] & { cacheMaxAge?: number };
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
    signal?: AbortSignal;
}

export async function fetchSubtitles(
    baseUrl: string,
    type: string,
    id: string,
    timeoutMs = 12_000,
    options: FetchSubtitlesOptions = {}
): Promise<StremioSubtitle[]> {
    const url = buildResourceUrl(baseUrl, 'subtitles', type, id);
    const policy = options.policy ?? { allowHttp: true };
    if (options.signal?.aborted) return [];
    try {
        const result = await secureFetch(url, {
            headers: DEFAULT_HEADERS,
            timeoutMs: options.timeoutMs ?? timeoutMs,
            maxBytes: options.maxBytes ?? 512_000,
            maxRedirects: options.maxRedirects ?? 3,
            acceptContentTypes: ['json', 'text/plain', 'javascript'],
            policy,
            viaProxy: 'auto',
            signal: options.signal
        });
        if (!result.response.ok) return [];
        const json = (await result.response.json()) as StremioSubtitleResponse;
        return Array.isArray(json?.subtitles) ? json.subtitles : [];
    } catch {
        return [];
    }
}
