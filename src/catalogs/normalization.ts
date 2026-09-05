/**
 * Catalog entry normalization (Phase 12 §15.1).
 *
 * Raw Stremio `metas` become provider-namespaced catalog entries:
 *   id → "<providerId>:<metaId>"
 * so catalog entries from different addons can never collide, and the
 * CINEFLIX frontend can pass the namespaced id straight back for meta
 * lookups. Poster/description/type are normalized; unknown fields are
 * dropped to keep responses stable.
 */
import { createHash } from 'node:crypto';
import type { StremioMeta } from '../stremio/protocol.js';

export interface NormalizedCatalogEntry {
    /** Namespaced id: "<providerId>:<metaId>" (collision-free across addons). */
    id: string;
    /** Original addon-local meta id. */
    metaId: string;
    type: string;
    name: string;
    poster?: string;
    background?: string;
    logo?: string;
    description?: string;
    releaseInfo?: string;
    imdbRating?: string;
    runtime?: string;
    genres?: string[];
    /** Provenance: which addon served this entry. */
    providerId: string;
}

/** Stremio content type → normalized bucket (mirrors the capability model). */
export function normalizeCatalogType(type: string | undefined): string {
    const t = (type ?? '').toLowerCase();
    if (t === 'movie' || t === 'series' || t === 'tv') return t;
    if (t === 'anime') return 'series';
    if (t === 'channel') return 'tv';
    return t || 'other';
}

export function normalizeCatalogEntries(
    metas: StremioMeta[] | undefined,
    providerId: string,
    opts: { maxItems?: number } = {}
): NormalizedCatalogEntry[] {
    const maxItems = Math.max(1, opts.maxItems ?? 100);
    const out: NormalizedCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const meta of Array.isArray(metas) ? metas : []) {
        if (out.length >= maxItems) break;
        if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string')
            continue;
        const metaId = meta.id.trim();
        if (!metaId) continue;
        const id = `${providerId}:${metaId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const entry: NormalizedCatalogEntry = {
            id,
            metaId,
            type: normalizeCatalogType(meta.type),
            name:
                typeof meta.name === 'string' && meta.name.trim()
                    ? meta.name.trim()
                    : metaId,
            providerId
        };
        if (typeof meta.poster === 'string') entry.poster = meta.poster;
        if (typeof meta.background === 'string')
            entry.background = meta.background;
        if (typeof meta.logo === 'string') entry.logo = meta.logo;
        if (typeof meta.description === 'string')
            entry.description = meta.description;
        if (typeof meta.releaseInfo === 'string')
            entry.releaseInfo = meta.releaseInfo;
        if (typeof meta.imdbRating === 'string')
            entry.imdbRating = meta.imdbRating;
        if (typeof meta.runtime === 'string') entry.runtime = meta.runtime;
        if (Array.isArray(meta.genres))
            entry.genres = meta.genres.filter(
                (g): g is string => typeof g === 'string'
            );
        out.push(entry);
    }
    return out;
}

/** Stable hash for the extra-parameter bag (cache key component). */
export function extraKey(extra: Record<string, string> | undefined): string {
    if (!extra || Object.keys(extra).length === 0) return 'none';
    return createHash('sha256')
        .update(
            Object.keys(extra)
                .sort()
                .map((k) => `${k}=${extra[k]}`)
                .join('&')
        )
        .digest('hex')
        .slice(0, 16);
}
