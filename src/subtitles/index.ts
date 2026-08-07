/**
 * Dedicated subtitle aggregation for GET /v1/subtitles.
 *
 * Queries every enabled addon that advertises the Stremio `subtitles` resource
 * and merges the results. Sources returned by the progressive scrape already
 * carry their own subtitles; this endpoint is the standalone path the frontend
 * uses when it wants subtitles independent of a chosen stream.
 */
import type { Subtitle } from '@omss/framework';
import type { AddonManager } from '../addons/manager.js';
import type {
    StremioManifest,
    StremioResource,
    StremioSubtitle
} from '../stremio/protocol.js';
import { fetchSubtitles } from '../stremio/client.js';
import { mapSubtitles } from '../stremio/mapper.js';
import { normalizeImdb } from '../stremio/ids.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';

function hasSubtitleResource(manifest: StremioManifest): boolean {
    const resources = manifest.resources;
    if (!Array.isArray(resources)) return false;
    return resources.some((r: StremioResource) =>
        typeof r === 'string' ? r === 'subtitles' : r?.name === 'subtitles'
    );
}

async function resolveImdb(
    imdbId?: string,
    tmdbId?: string,
    type: 'movie' | 'tv' = 'movie'
): Promise<string> {
    if (imdbId) return normalizeImdb(imdbId);
    if (!tmdbId) return '';
    const key = process.env.TMDB_API_KEY;
    if (!key) return '';
    try {
        const path = type === 'tv' ? 'tv' : 'movie';
        const res = await fetch(
            `https://api.themoviedb.org/3/${path}/${encodeURIComponent(
                tmdbId
            )}/external_ids?api_key=${encodeURIComponent(key)}`,
            { signal: AbortSignal.timeout(10_000) }
        );
        if (!res.ok) return '';
        const data = (await res.json()) as { imdb_id?: string | null };
        return data.imdb_id ? normalizeImdb(data.imdb_id) : '';
    } catch {
        return '';
    }
}

export interface SubtitleQuery {
    imdbId?: string;
    tmdbId?: string;
    season?: number;
    episode?: number;
    language?: string;
}

export interface SubtitleAggregateResult {
    subtitles: Subtitle[];
    addonsQueried: number;
    error?: string;
}

export interface SubtitleAggregateOptions {
    /** When set, issue short-lived playback grants instead of legacy proxy URLs. */
    grants?: PlaybackGrantStore;
    secureProxy?: boolean;
}

export async function aggregateSubtitles(
    manager: AddonManager,
    publicUrl: string,
    query: SubtitleQuery,
    options: SubtitleAggregateOptions = {}
): Promise<SubtitleAggregateResult> {
    const isSeries = query.season != null && query.episode != null;
    const type: 'movie' | 'tv' = isSeries ? 'tv' : 'movie';
    const stremioType = isSeries ? 'series' : 'movie';

    const imdb = await resolveImdb(query.imdbId, query.tmdbId, type);
    if (!imdb) {
        return {
            subtitles: [],
            addonsQueried: 0,
            error: 'Could not resolve an IMDb id (provide imdbId, or tmdbId with a TMDB key)'
        };
    }
    const id = isSeries ? `${imdb}:${query.season}:${query.episode}` : imdb;

    const capable = manager
        .list()
        .filter((a) => a.enabled && hasSubtitleResource(a.manifest));

    const collected: StremioSubtitle[] = [];
    const urlPolicy = manager.urlPolicy();
    await Promise.all(
        capable.map(async (addon) => {
            try {
                const subs = await fetchSubtitles(
                    addon.baseUrl,
                    stremioType,
                    id,
                    12_000,
                    {
                        policy: urlPolicy
                    }
                );
                collected.push(...subs);
            } catch {
                /* best-effort per addon */
            }
        })
    );

    const base = publicUrl.replace(/\/$/, '');
    const useGrants = options.secureProxy !== false && options.grants;

    // Issue grants per unique subtitle URL when secure proxy is on.
    const out: Subtitle[] = [];
    const seen = new Set<string>();
    for (const s of collected) {
        if (!s?.url || !/^https?:\/\//i.test(s.url)) continue;
        if (seen.has(s.url)) continue;
        seen.add(s.url);

        let proxied: string;
        if (useGrants && options.grants) {
            try {
                const grant = await options.grants.issue({
                    url: s.url,
                    providerId: 'subtitles'
                });
                proxied = options.grants.toProxyUrl(grant, base);
            } catch {
                continue;
            }
        } else {
            // Legacy path only when secure proxy is explicitly off.
            proxied = `${base}/v1/proxy?data=${encodeURIComponent(
                JSON.stringify({ url: s.url })
            )}`;
        }
        const mapped = mapSubtitles([s], () => proxied);
        out.push(...mapped);
    }

    let subtitles = out;
    if (query.language) {
        const lang = query.language.toLowerCase();
        const filtered = subtitles.filter((s) =>
            s.label.toLowerCase().includes(lang)
        );
        if (filtered.length) subtitles = filtered;
    }

    return { subtitles, addonsQueried: capable.length };
}
