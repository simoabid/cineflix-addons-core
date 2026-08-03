/**
 * Stremio ID helpers.
 *
 * Stremio identifies content by IMDb id (`tt1234567`, series `tt…:s:e`).
 * Some addons also accept `tmdb:` ids. We build an ordered list of candidate
 * ids based on what the addon's manifest advertises via `idPrefixes`, then the
 * caller tries them until one returns streams.
 */
import type { ProviderMediaObject } from '@omss/framework';
import type { StremioManifest } from './protocol.js';

/** OMSS media type → Stremio content type. */
export function toStremioType(type: 'movie' | 'tv'): 'movie' | 'series' {
    return type === 'tv' ? 'series' : 'movie';
}

export function normalizeImdb(id: string): string {
    const clean = id.trim();
    if (!clean) return '';
    return clean.startsWith('tt') ? clean : `tt${clean}`;
}

function supportsPrefix(manifest: StremioManifest, prefix: string): boolean {
    const prefixes = manifest.idPrefixes;
    // No declared prefixes → assume the de-facto standard (imdb `tt`).
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
        return prefix === 'tt';
    }
    return prefixes.some((p) => typeof p === 'string' && p.startsWith(prefix));
}

/**
 * Build ordered candidate Stremio ids for a media object.
 * IMDb ids are preferred (widest addon support), TMDB ids are a fallback.
 */
export function buildIdCandidates(
    manifest: StremioManifest,
    media: ProviderMediaObject
): string[] {
    const ids: string[] = [];
    const isSeries = media.type === 'tv';
    const season = media.s;
    const episode = media.e;

    const imdb = media.imdbId ? normalizeImdb(media.imdbId) : '';
    if (imdb && supportsPrefix(manifest, 'tt')) {
        ids.push(
            isSeries && season != null && episode != null
                ? `${imdb}:${season}:${episode}`
                : imdb
        );
    }

    const tmdb = media.tmdbId ? String(media.tmdbId) : '';
    if (tmdb && supportsPrefix(manifest, 'tmdb')) {
        ids.push(
            isSeries && season != null && episode != null
                ? `tmdb:${tmdb}:${season}:${episode}`
                : `tmdb:${tmdb}`
        );
    }

    // De-dupe while preserving order.
    return [...new Set(ids)];
}

/** Whether this addon can serve the given media type at all. */
export function manifestSupportsType(
    manifest: StremioManifest,
    type: 'movie' | 'tv'
): boolean {
    const types = manifest.types;
    if (!Array.isArray(types) || types.length === 0) return true;
    const stremioType = toStremioType(type);
    return types.some(
        (t) =>
            t === stremioType ||
            (type === 'tv' && (t === 'tv' || t === 'series'))
    );
}
