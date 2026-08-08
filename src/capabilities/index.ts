/**
 * Addon capability model — Phase 2.1
 *
 * Normalizes the loose Stremio manifest interpretation into an explicit
 * capability shape. Handles:
 *  - string vs object resources
 *  - merging manifest-level and resource-level types/idPrefixes
 *  - distinguishing stream / subtitles / catalog / meta
 *  - exposing a clear `status` for unsupported/limited manifests
 */

import type {
    StremioManifest,
    StremioResource
} from '../stremio/protocol.js';

/**
 * Normalized descriptor for a single resource entry.
 */
export interface NormalizedResource {
    name: 'stream' | 'subtitles' | 'catalog' | 'meta';
    /** Raw types as declared (or undefined when not declared). */
    rawTypes?: string[];
    /** Raw idPrefixes as declared. */
    rawIdPrefixes?: string[];
    /** Effective media types after merging with manifest defaults. */
    mediaTypes: Array<'movie' | 'series' | 'tv'>;
    /** Effective id prefixes after merging. */
    idPrefixes: string[];
}

export type CapabilityEntry = {
    mediaTypes: Array<'movie' | 'series' | 'tv'>;
    idPrefixes: string[];
};

export type AddonCapabilityStatus = 'supported' | 'limited' | 'unsupported';

export type AddonCapabilities = {
    stream: CapabilityEntry[];
    subtitles: CapabilityEntry[];
    catalog: boolean;
    meta: boolean;
    /** Overall usefulness to this backend (stream/subtitle pipeline). */
    status: AddonCapabilityStatus;
    /** Human-readable reason when status !== supported. */
    statusReason?: string;
    /** Raw normalized resources for debugging. */
    resources: NormalizedResource[];
};

// Known media types we care about for stream/subtitle pipeline.
// Stremio uses "movie" and "series" (tv is legacy alias). We normalize
// "tv" and "channel"/"anime" to our three buckets so downstream filtering
// is predictable.
const KNOWN_TYPE_MAP: Record<string, 'movie' | 'series' | 'tv'> = {
    movie: 'movie',
    series: 'series',
    tv: 'tv',
    channel: 'tv',
    anime: 'series'
};

const VALID_RESOURCE_NAMES = new Set(['stream', 'subtitles', 'catalog', 'meta']);

function normalizeMediaTypes(
    types: unknown,
    fallback: string[] | undefined
): Array<'movie' | 'series' | 'tv'> {
    const src = Array.isArray(types) ? types : fallback;
    if (!src || src.length === 0) {
        // No restriction — assume all.
        return ['movie', 'series', 'tv'];
    }
    const out = new Set<'movie' | 'series' | 'tv'>();
    for (const t of src) {
        if (typeof t !== 'string') continue;
        const mapped = KNOWN_TYPE_MAP[t.toLowerCase()];
        if (mapped) out.add(mapped);
        else if (t === 'movie' || t === 'series' || t === 'tv') out.add(t as never);
    }
    return out.size ? [...out] : ['movie', 'series', 'tv'];
}

function normalizeIdPrefixes(
    prefixes: unknown,
    fallback: unknown
): string[] {
    const src = Array.isArray(prefixes)
        ? prefixes
        : Array.isArray(fallback)
            ? fallback
            : undefined;
    if (!src || src.length === 0) {
        // De-facto default per ids.ts: tt for streams/subs.
        return ['tt'];
    }
    const out: string[] = [];
    for (const p of src) {
        if (typeof p !== 'string') continue;
        const trimmed = p.trim();
        if (!trimmed) continue;
        out.push(trimmed);
    }
    return out.length ? out : ['tt'];
}

function normalizeResourceEntry(
    r: StremioResource,
    manifest: StremioManifest
): NormalizedResource | null {
    let name: string;
    let types: string[] | undefined;
    let idPrefixes: string[] | undefined;

    if (typeof r === 'string') {
        name = r;
    } else if (r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string') {
        name = (r as { name: string }).name;
        const obj = r as { types?: unknown; idPrefixes?: unknown };
        if (Array.isArray(obj.types)) types = obj.types as string[];
        if (Array.isArray(obj.idPrefixes)) idPrefixes = obj.idPrefixes as string[];
    } else {
        return null;
    }

    if (!VALID_RESOURCE_NAMES.has(name)) return null;

    // catalog/meta have no per-type filtering in our model — they are booleans.
    if (name === 'catalog' || name === 'meta') {
        return {
            name: name as 'catalog' | 'meta',
            rawTypes: types,
            rawIdPrefixes: idPrefixes,
            mediaTypes: normalizeMediaTypes(types, manifest.types as string[] | undefined),
            idPrefixes: normalizeIdPrefixes(idPrefixes, manifest.idPrefixes)
        };
    }

    // stream / subtitles
    return {
        name: name as 'stream' | 'subtitles',
        rawTypes: types,
        rawIdPrefixes: idPrefixes,
        mediaTypes: normalizeMediaTypes(types, manifest.types as string[] | undefined),
        idPrefixes: normalizeIdPrefixes(idPrefixes, manifest.idPrefixes)
    };
}

/**
 * Parse manifest.resources (string and object forms) into normalized descriptors,
 * merging manifest-level types/idPrefixes correctly.
 */
export function normalizeResources(manifest: StremioManifest): NormalizedResource[] {
    const raw = manifest.resources;
    if (!Array.isArray(raw)) return [];
    const out: NormalizedResource[] = [];
    for (const r of raw) {
        const n = normalizeResourceEntry(r as StremioResource, manifest);
        if (n) out.push(n);
    }
    return out;
}

export function deriveCapabilities(manifest: StremioManifest): AddonCapabilities {
    const resources = normalizeResources(manifest);

    const stream = resources
        .filter((r) => r.name === 'stream')
        .map((r) => ({ mediaTypes: r.mediaTypes, idPrefixes: r.idPrefixes }));

    const subtitles = resources
        .filter((r) => r.name === 'subtitles')
        .map((r) => ({ mediaTypes: r.mediaTypes, idPrefixes: r.idPrefixes }));

    const catalog = resources.some((r) => r.name === 'catalog');
    const meta = resources.some((r) => r.name === 'meta');

    let status: AddonCapabilityStatus = 'supported';
    let statusReason: string | undefined;

    if (stream.length === 0 && subtitles.length === 0) {
        if (catalog || meta) {
            status = 'limited';
            statusReason = catalog && meta
                ? 'catalog/meta only — no stream or subtitle resources'
                : catalog
                    ? 'catalog only — no stream or subtitle resources'
                    : 'meta only — no stream or subtitle resources';
        } else if (resources.length === 0) {
            status = 'unsupported';
            // Distinguish empty resources vs unknown resources
            const rawLen = Array.isArray(manifest.resources) ? manifest.resources.length : 0;
            if (rawLen === 0) {
                statusReason = 'no advertised resources';
            } else {
                statusReason = 'no stream/subtitle/catalog/meta resources advertised';
            }
        } else {
            status = 'unsupported';
            statusReason = 'advertises resources but none usable for stream/subtitle pipeline';
        }
    }

    return {
        stream,
        subtitles,
        catalog,
        meta,
        status,
        statusReason,
        resources
    };
}

// ── capability predicates ───────────────────────────────────────────────────

export function isStreamCapable(cap: AddonCapabilities): boolean {
    return cap.stream.length > 0;
}

export function isSubtitleCapable(cap: AddonCapabilities): boolean {
    return cap.subtitles.length > 0;
}

export function isCatalogOnly(cap: AddonCapabilities): boolean {
    return cap.status === 'limited' && cap.catalog && !isStreamCapable(cap) && !isSubtitleCapable(cap);
}

export function canServeMediaType(
    cap: AddonCapabilities,
    kind: 'stream' | 'subtitles',
    mediaType: 'movie' | 'series' | 'tv'
): boolean {
    const entries = kind === 'stream' ? cap.stream : cap.subtitles;
    return entries.some((e) => e.mediaTypes.includes(mediaType));
}

export function supportsIdPrefix(
    cap: AddonCapabilities,
    kind: 'stream' | 'subtitles',
    prefix: string
): boolean {
    const entries = kind === 'stream' ? cap.stream : cap.subtitles;
    return entries.some((e) => e.idPrefixes.some((p) => prefix.startsWith(p) || p.startsWith(prefix)));
}

/**
 * Whether this addon can serve the given media via at least one stream or
 * subtitle entry (id prefix + type). Used for provider selection filtering.
 */
export function canServeMedia(
    manifest: StremioManifest,
    media: { type: 'movie' | 'tv'; imdbId?: string; tmdbId?: string },
    kind: 'stream' | 'subtitles' = 'stream'
): boolean {
    const cap = deriveCapabilities(manifest);
    const entries = kind === 'stream' ? cap.stream : cap.subtitles;
    if (entries.length === 0) return false;
    // Map OMSS type to stremio media type
    const mediaType: 'movie' | 'series' | 'tv' =
        media.type === 'movie' ? 'movie' : 'series';
    // Check type compatibility first
    const typeOk = entries.some((e) => e.mediaTypes.includes(mediaType) || e.mediaTypes.includes('tv'));
    if (!typeOk) return false;
    // If no IDs, pessimistically assume compatible (caller will try)
    if (!media.imdbId && !media.tmdbId) return true;
    // Check prefix compatibility: at least one entry's idPrefixes matches an available ID
    const prefixesToTest: string[] = [];
    if (media.imdbId) prefixesToTest.push('tt');
    if (media.tmdbId) prefixesToTest.push('tmdb');
    return prefixesToTest.some((p) =>
        entries.some((e) => e.idPrefixes.some((idp) => idp.startsWith(p) || p.startsWith(idp) || idp === p))
    );
}
