/**
 * Structured addon URL handling — Phase 2.3
 *
 * Stremio addon configuration is often encoded in the path or query string:
 *   https://torrentio.strem.fun/<base64-config>/manifest.json
 *   https://host/addon?token=abc&opts=...
 *   stremio://host/configure?x=1
 *
 * We must preserve configuration-bearing segments while still normalizing
 * for identity/dedupe. String splitting (`indexOf('?')`) is fragile, so
 * this module uses the WHATWG URL parser as the structured source of truth
 * and keeps `original`, `manifestUrl`, and `baseUrl` as separate fields
 * that are never recombined via naive splits.
 */

export interface StructuredAddonUrl {
    /** What the operator pasted. */
    original: string;
    /** Canonical manifest URL (…/manifest.json plus preserved search). */
    manifestUrl: string;
    /** Base URL for resource calls (prefix before /stream/... , with search preserved). */
    baseUrl: string;
    /** Origin (protocol + host + port). */
    origin: string;
    /** Normalized pathname without trailing slash, without /manifest.json. */
    pathnameBase: string;
    /** Preserved search string including leading "?" or empty. */
    search: string;
    /** Config fingerprint for dedupe: origin + pathnameBase + stable-sorted query (lowercased keys). */
    fingerprint: string;
}

/**
 * Normalize an addon URL into a StructuredAddonUrl. Accepts bare hosts,
 * stremio://, with or without /manifest.json, with query path config.
 */
export function parseAddonUrl(input: string): StructuredAddonUrl {
    const original = input.trim();
    if (!original) throw new Error('Empty addon URL');

    let raw = original;
    if (raw.startsWith('stremio://')) raw = 'https://' + raw.slice('stremio://'.length);
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error(`Invalid addon URL: ${input}`);
    }

    // Normalize base path: strip /manifest.json, remove trailing slash
    let pathBase = u.pathname.replace(/\/+$/, '');
    if (pathBase.toLowerCase().endsWith('/manifest.json')) {
        pathBase = pathBase.slice(0, -'/manifest.json'.length) || '';
    }
    if (pathBase.endsWith('/') && pathBase.length > 1) pathBase = pathBase.slice(0, -1);

    const origin = `${u.protocol}//${u.host}`;
    const search = u.search; // includes "?" or ""

    const baseUrl = `${origin}${pathBase}${search}`;
    const manifestUrl = `${origin}${pathBase}/manifest.json${search}`;

    // Fingerprint: normalized origin (lowercased host, no default port), pathBase lowercased? Keep case for config but normalize host.
    // Sort query params by key for stability for dedupe (values may be order-sensitive but keys sorted is stable enough).
    let fingerprint: string;
    try {
        const fpUrl = new URL(manifestUrl);
        // Normalize host lower
        fpUrl.hostname = fpUrl.hostname.toLowerCase();
        // Strip default ports
        if ((fpUrl.protocol === 'https:' && fpUrl.port === '443') || (fpUrl.protocol === 'http:' && fpUrl.port === '80')) {
            fpUrl.port = '';
        }
        // Stable sort query params
        const entries = [...fpUrl.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        fpUrl.search = '';
        for (const [k, v] of entries) fpUrl.searchParams.append(k, v);
        // Fingerprint is origin/path+search lowercased host, preserving case in path (config may be case sensitive base64)
        fingerprint = fpUrl.origin + fpUrl.pathname + fpUrl.search;
    } catch {
        fingerprint = manifestUrl;
    }

    return {
        original,
        manifestUrl,
        baseUrl,
        origin,
        pathnameBase: pathBase,
        search,
        fingerprint
    };
}

/**
 * Build resource URLs from a preserved baseUrl without losing query config.
 * Uses URL parser, not string splitting.
 */
export function buildResourceUrl(baseUrl: string, resource: string, type: string, id: string): string {
    const base = new URL(baseUrl);
    const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
    const encoded = `/${encodeURIComponent(resource)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const search = base.search; // preserved
    return `${root}${encoded}${search}`;
}

/**
 * Split base into root + search using URL parser (replaces indexOf('?') splits).
 */
export function splitBaseStructured(baseUrl: string): { root: string; search: string } {
    try {
        const u = new URL(baseUrl);
        const root = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
        return { root, search: u.search };
    } catch {
        const q = baseUrl.indexOf('?');
        if (q === -1) return { root: baseUrl.replace(/\/+$/, ''), search: '' };
        return { root: baseUrl.slice(0, q).replace(/\/+$/, ''), search: baseUrl.slice(q) };
    }
}

/**
 * Whether two addon URLs refer to the same logical addon (fingerprint equal).
 * Used for dedupe/idempotency beyond raw manifestUrl string equality.
 */
export function sameAddonIdentity(a: string, b: string): boolean {
    try {
        return parseAddonUrl(a).fingerprint === parseAddonUrl(b).fingerprint;
    } catch {
        return a.trim() === b.trim();
    }
}

/**
 * Redacted view for logs: keeps path/config but hides sensitive query values.
 */
export function redactAddonUrl(url: string): string {
    try {
        const parsed = new URL(
            url.startsWith('stremio://') ? 'https://' + url.slice('stremio://'.length) : url.startsWith('http') ? url : 'https://' + url
        );
        // Reuse redactUrl logic without importing; simple inline redaction
        const sensitive = /token|key|secret|auth|pass|api/i;
        for (const key of [...parsed.searchParams.keys()]) {
            if (sensitive.test(key)) parsed.searchParams.set(key, '[REDACTED]');
        }
        if (parsed.username) parsed.username = '[REDACTED]';
        if (parsed.password) parsed.password = '';
        return parsed.toString();
    } catch {
        return url;
    }
}
