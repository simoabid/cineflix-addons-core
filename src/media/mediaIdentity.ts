/**
 * MediaIdentityService — Phase 2.4
 *
 * Unifies media metadata resolution across bulk, progressive, subtitle,
 * and native Stremio routes. Previously each path fetched TMDB separately
 * with different caches and error handling.
 *
 * Responsibilities:
 *  - Validate TMDB IDs and season/episode ranges
 *  - Fetch title, release year, and external IDs once per media key
 *  - Use one cache + one error taxonomy
 *  - Propagate AbortSignal and request deadline
 *  - Allow fallback when IMDb missing but addon supports TMDB IDs
 */

import type { ProviderMediaObject } from '@omss/framework';
import { tracer } from '../telemetry/tracing.js';

export type MediaKind = 'movie' | 'tv';

export interface MediaIdentity {
    media: ProviderMediaObject;
    /** Cache-hit flag for diagnostics. */
    fromCache?: boolean;
}

export interface MediaIdentityOptions {
    /** Abort signal from the inbound request. */
    signal?: AbortSignal;
    /** Absolute deadline ms (Date.now() + budget). When reached, abort. */
    deadlineMs?: number;
    /** Allow TMDB-only resolution when IMDb unavailable. */
    allowTmdbFallback?: boolean;
}

export class MediaIdentityError extends Error {
    readonly code:
        | 'INVALID_TMDB_ID'
        | 'INVALID_SEASON_EPISODE'
        | 'TMDB_NOT_FOUND'
        | 'TMDB_ERROR'
        | 'TIMEOUT'
        | 'ABORTED';
    readonly status: number;

    constructor(
        code: MediaIdentityError['code'],
        message: string,
        status = 400
    ) {
        super(message);
        this.name = 'MediaIdentityError';
        this.code = code;
        this.status = status;
    }
}

// In-memory LRU-ish cache for media objects.
// Key: `movie:tmdbId` or `tv:tmdbId:s:e`
// TTL 6h for identity (shorter than TMDBService's 24h but still effective).
const MEDIA_CACHE = new Map<
    string,
    { value: ProviderMediaObject; expiresAt: number }
>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000; // short for not-found/errors
const negativeCache = new Map<
    string,
    { error: MediaIdentityError; expiresAt: number }
>();

function cacheKey(
    kind: MediaKind,
    tmdbId: string,
    s?: number,
    e?: number
): string {
    return kind === 'movie' ? `movie:${tmdbId}` : `tv:${tmdbId}:s${s}:e${e}`;
}

function isValidTmdbId(id: string): boolean {
    return /^\d+$/.test(id) && Number(id) > 0 && id.length <= 10;
}

function isValidSeasonEpisode(s?: number, e?: number): boolean {
    if (s == null || e == null) return false;
    return (
        Number.isInteger(s) &&
        Number.isInteger(e) &&
        s > 0 &&
        s < 100 &&
        e > 0 &&
        e < 1000
    );
}

async function tmdbFetch<T>(
    path: string,
    opts: MediaIdentityOptions = {}
): Promise<T> {
    const key = process.env.TMDB_API_KEY?.trim();
    if (!key)
        throw new MediaIdentityError(
            'TMDB_ERROR',
            'TMDB_API_KEY not configured',
            500
        );

    const remaining = opts.deadlineMs ? opts.deadlineMs - Date.now() : 12_000;
    if (remaining <= 0)
        throw new MediaIdentityError(
            'TIMEOUT',
            'Media identity deadline exceeded',
            504
        );

    const url = `https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;

    // Merge caller signal + timeout signal
    const timeoutSignal = AbortSignal.timeout(Math.min(remaining, 12_000));
    const signal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;

    let res: Response;
    try {
        res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal
        });
    } catch (err) {
        if (
            err instanceof Error &&
            (err.name === 'AbortError' || err.name === 'TimeoutError')
        ) {
            if (err.name === 'TimeoutError' || !opts.signal?.aborted) {
                throw new MediaIdentityError(
                    'TIMEOUT',
                    'TMDB request timed out',
                    504
                );
            }
            throw new MediaIdentityError('ABORTED', 'Request aborted', 499);
        }
        throw new MediaIdentityError(
            'TMDB_ERROR',
            err instanceof Error ? err.message : String(err),
            502
        );
    }

    if (!res.ok) {
        if (res.status === 404)
            throw new MediaIdentityError(
                'TMDB_NOT_FOUND',
                `TMDB not found for ${path}`,
                404
            );
        throw new MediaIdentityError(
            'TMDB_ERROR',
            `TMDB HTTP ${res.status} for ${path}`,
            502
        );
    }

    try {
        return (await res.json()) as T;
    } catch {
        throw new MediaIdentityError(
            'TMDB_ERROR',
            'TMDB returned invalid JSON',
            502
        );
    }
}

type TmdbMovie = {
    title?: string;
    release_date?: string;
    external_ids?: { imdb_id?: string | null };
};

type TmdbTv = {
    name?: string;
    first_air_date?: string;
    external_ids?: { imdb_id?: string | null };
};

export class MediaIdentityService {
    /**
     * Resolve ProviderMediaObject for movie or episode.
     * Throws MediaIdentityError on validation / not found / timeout.
     */
    async resolve(
        kind: MediaKind,
        tmdbId: string,
        season?: number,
        episode?: number,
        opts: MediaIdentityOptions = {}
    ): Promise<MediaIdentity> {
        return tracer.withSpan(
            'media.identity.resolve',
            async (span) => {
                span.setAttribute('media.kind', kind);
                span.setAttribute('media.tmdb_id', tmdbId);
                if (season !== undefined) span.setAttribute('media.season', season);
                if (episode !== undefined)
                    span.setAttribute('media.episode', episode);

                if (!isValidTmdbId(tmdbId)) {
                    throw new MediaIdentityError(
                        'INVALID_TMDB_ID',
                        `Invalid TMDB id: ${tmdbId}`,
                        400
                    );
                }
                if (kind === 'tv') {
                    if (!isValidSeasonEpisode(season, episode)) {
                        throw new MediaIdentityError(
                            'INVALID_SEASON_EPISODE',
                            `Invalid season/episode: s=${season} e=${episode} (expected s 1..99, e 1..999)`,
                            400
                        );
                    }
                }

                const k = cacheKey(kind, tmdbId, season, episode);
                const cached = MEDIA_CACHE.get(k);
                if (cached && Date.now() < cached.expiresAt) {
                    span.setAttribute('media.from_cache', true);
                    return { media: cached.value, fromCache: true };
                }
                const neg = negativeCache.get(k);
                if (neg && Date.now() < neg.expiresAt) throw neg.error;

                try {
                    const media = await this.fetchMedia(
                        kind,
                        tmdbId,
                        season,
                        episode,
                        opts
                    );
                    MEDIA_CACHE.set(k, {
                        value: media,
                        expiresAt: Date.now() + CACHE_TTL_MS
                    });
                    // Cap cache size
                    if (MEDIA_CACHE.size > 1000) {
                        const first = MEDIA_CACHE.keys().next().value as
                            | string
                            | undefined;
                        if (first) MEDIA_CACHE.delete(first);
                    }
                    span.setAttribute('media.from_cache', false);
                    return { media, fromCache: false };
                } catch (err) {
                    if (err instanceof MediaIdentityError) {
                        // Negative cache short for 404, longer for timeout? Keep short to allow retry
                        if (
                            err.code === 'TMDB_NOT_FOUND' ||
                            err.code === 'INVALID_TMDB_ID'
                        ) {
                            negativeCache.set(k, {
                                error: err,
                                expiresAt: Date.now() + NEGATIVE_TTL_MS
                            });
                        }
                    }
                    throw err;
                }
            },
            {
                attributes: {
                    'media.kind': kind,
                    'media.tmdb_id': tmdbId
                }
            }
        );
    }

    private async fetchMedia(
        kind: MediaKind,
        tmdbId: string,
        season: number | undefined,
        episode: number | undefined,
        opts: MediaIdentityOptions
    ): Promise<ProviderMediaObject> {
        if (kind === 'movie') {
            const d = await tmdbFetch<TmdbMovie>(
                `/movie/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`,
                opts
            );
            return {
                type: 'movie',
                tmdbId: String(tmdbId),
                title: d.title ?? 'Unknown',
                releaseYear: d.release_date?.slice(0, 4) ?? '',
                imdbId: d.external_ids?.imdb_id ?? ''
            };
        }

        const s = season!;
        const e = episode!;
        const d = await tmdbFetch<TmdbTv>(
            `/tv/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`,
            opts
        );
        return {
            type: 'tv',
            tmdbId: String(tmdbId),
            title: d.name ?? 'Unknown',
            releaseYear: d.first_air_date?.slice(0, 4) ?? '',
            imdbId: d.external_ids?.imdb_id ?? '',
            s,
            e
        };
    }

    /**
     * Like resolve() but returns a diagnostics-wrapped result for progressive
     * routes that prefer soft errors over throwing.
     */
    async resolveOrSoft(
        kind: MediaKind,
        tmdbId: string,
        season?: number,
        episode?: number,
        opts: MediaIdentityOptions = {}
    ): Promise<{
        media?: ProviderMediaObject;
        error?: MediaIdentityError;
        fromCache?: boolean;
    }> {
        try {
            const r = await this.resolve(kind, tmdbId, season, episode, opts);
            return { media: r.media, fromCache: r.fromCache };
        } catch (err) {
            if (err instanceof MediaIdentityError) return { error: err };
            throw err;
        }
    }

    clearCache(): void {
        MEDIA_CACHE.clear();
        negativeCache.clear();
    }

    cacheSize(): number {
        return MEDIA_CACHE.size;
    }
}

export const globalMediaIdentity = new MediaIdentityService();

// ── backwards-compat wrappers for progressiveScrape ─────────────────────────

export async function buildProgressiveMedia(
    type: 'movie' | 'tv',
    tmdbId: string,
    season?: number,
    episode?: number,
    opts: MediaIdentityOptions = {}
): Promise<ProviderMediaObject> {
    const r = await globalMediaIdentity.resolve(
        type,
        tmdbId,
        season,
        episode,
        opts
    );
    return r.media;
}
