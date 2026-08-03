/**
 * Progressive single-provider (single-addon) scrape helpers.
 *
 * Mirrors cineflix-core so the CINEFLIX frontend can waterfall addons
 * best → worst and start playback without waiting for a bulk scrape:
 *   GET /v1/movies/:tmdbId/providers/:providerId
 *   GET /v1/tv/:tmdbId/seasons/:s/episodes/:e/providers/:providerId
 */
import type { ProviderMediaObject, ProviderRegistry } from '@omss/framework';
import type { AddonManager } from './addons/manager.js';

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

async function tmdbFetch<T>(path: string): Promise<T> {
    const key = process.env.TMDB_API_KEY;
    if (!key) throw new Error('TMDB_API_KEY not configured');
    const url = `https://api.themoviedb.org/3${path}${
        path.includes('?') ? '&' : '?'
    }api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status} for ${path}`);
    return (await res.json()) as T;
}

export async function buildProgressiveMedia(
    type: 'movie' | 'tv',
    tmdbId: string,
    season?: number,
    episode?: number
): Promise<ProviderMediaObject> {
    if (type === 'movie') {
        const d = await tmdbFetch<TmdbMovie>(
            `/movie/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`
        );
        return {
            type: 'movie',
            tmdbId: String(tmdbId),
            title: d.title ?? 'Unknown',
            releaseYear: d.release_date?.slice(0, 4) ?? '',
            imdbId: d.external_ids?.imdb_id ?? ''
        };
    }
    const s = season ?? 1;
    const e = episode ?? 1;
    const d = await tmdbFetch<TmdbTv>(
        `/tv/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`
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

async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_res, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} timed out after ${ms}ms`)),
                    ms
                );
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export interface SingleProviderResult {
    sources: unknown[];
    subtitles: unknown[];
    diagnostics: unknown[];
    providerId: string;
    providerName: string;
    durationMs: number;
}

export async function scrapeSingleProvider(
    registry: ProviderRegistry,
    providerId: string,
    media: ProviderMediaObject,
    timeoutMs: number
): Promise<SingleProviderResult> {
    const provider = registry.getProvider(providerId);
    if (!provider) {
        const err = new Error(`Provider not found: ${providerId}`) as Error & {
            statusCode?: number;
        };
        err.statusCode = 404;
        throw err;
    }
    if (!provider.enabled) {
        const err = new Error(`Provider disabled: ${providerId}`) as Error & {
            statusCode?: number;
        };
        err.statusCode = 404;
        throw err;
    }

    const start = Date.now();
    try {
        const result = await withTimeout(
            media.type === 'movie'
                ? provider.getMovieSources(media)
                : provider.getTVSources(media),
            timeoutMs,
            provider.name
        );
        return {
            sources: Array.isArray(result.sources) ? result.sources : [],
            subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
            diagnostics: Array.isArray(result.diagnostics)
                ? result.diagnostics
                : [],
            providerId: provider.id,
            providerName: provider.name,
            durationMs: Date.now() - start
        };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Unknown provider error';
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${provider.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ],
            providerId: provider.id,
            providerName: provider.name,
            durationMs: Date.now() - start
        };
    }
}

/** `/v1/providers` payload — all installed addons with priority + enabled flag. */
export function listProvidersWithPriority(manager: AddonManager): Array<{
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    tier: string | null;
}> {
    return manager.list().map((a, i) => ({
        id: a.providerId,
        name: a.name,
        enabled: a.enabled,
        priority: i,
        tier: null
    }));
}
