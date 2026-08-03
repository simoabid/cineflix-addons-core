/**
 * Low-level Stremio addon HTTP client.
 *
 * Talks the Stremio Addon Protocol over HTTP:
 *   {base}/manifest.json
 *   {base}/stream/{type}/{id}.json
 *   {base}/subtitles/{type}/{id}.json
 *
 * All requests go through the egress proxy (scrapeFetch) so a self-hosted
 * instance on EC2 doesn't get IP-blocked by addon backends.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
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
 * `{ manifestUrl, baseUrl }`. Accepts:
 *   - https://host/path/manifest.json
 *   - https://host/path            (assumed base; /manifest.json appended)
 *   - stremio://host/path/manifest.json
 */
export function normalizeAddonUrl(input: string): {
    manifestUrl: string;
    baseUrl: string;
} {
    let raw = input.trim();
    if (!raw) throw new StremioAddonError('Empty addon URL');

    // stremio:// deep-links are just http(s) with a custom scheme
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

    const baseUrl = `${u.origin}${path}`;
    const manifestUrl = `${baseUrl}/manifest.json${u.search}`;
    return { manifestUrl, baseUrl: baseUrl + u.search };
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

export async function fetchManifest(
    addonUrl: string,
    timeoutMs = 15_000
): Promise<{ manifest: StremioManifest; baseUrl: string }> {
    const { manifestUrl, baseUrl } = normalizeAddonUrl(addonUrl);
    const res = await scrapeFetch(manifestUrl, {
        headers: DEFAULT_HEADERS,
        timeoutMs
    });
    if (!res.ok) {
        throw new StremioAddonError(
            `Manifest HTTP ${res.status} for ${manifestUrl}`,
            manifestUrl
        );
    }
    let manifest: StremioManifest;
    try {
        manifest = (await res.json()) as StremioManifest;
    } catch {
        throw new StremioAddonError(
            `Manifest is not valid JSON: ${manifestUrl}`,
            manifestUrl
        );
    }
    if (!manifest || typeof manifest !== 'object' || !manifest.id) {
        throw new StremioAddonError(
            `Manifest missing required 'id': ${manifestUrl}`,
            manifestUrl
        );
    }
    return { manifest, baseUrl };
}

export async function fetchStreams(
    baseUrl: string,
    type: string,
    id: string,
    timeoutMs = 20_000
): Promise<StremioStream[]> {
    const { root, query } = splitBase(baseUrl);
    const url = `${root}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json${query}`;
    const res = await scrapeFetch(url, {
        headers: DEFAULT_HEADERS,
        timeoutMs
    });
    if (!res.ok) {
        throw new StremioAddonError(`Stream HTTP ${res.status}`, url);
    }
    const json = (await res.json()) as StremioStreamResponse;
    return Array.isArray(json?.streams) ? json.streams : [];
}

export async function fetchSubtitles(
    baseUrl: string,
    type: string,
    id: string,
    timeoutMs = 12_000
): Promise<StremioSubtitle[]> {
    const { root, query } = splitBase(baseUrl);
    const url = `${root}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json${query}`;
    try {
        const res = await scrapeFetch(url, {
            headers: DEFAULT_HEADERS,
            timeoutMs
        });
        if (!res.ok) return [];
        const json = (await res.json()) as StremioSubtitleResponse;
        return Array.isArray(json?.subtitles) ? json.subtitles : [];
    } catch {
        return [];
    }
}
