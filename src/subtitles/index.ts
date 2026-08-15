/**
 * Dedicated subtitle aggregation for GET /v1/subtitles.
 *
 * Queries every enabled addon that is subtitle-capable (capability model) and
 * merges results. Uses MediaIdentityService as the single TMDB/IMDb resolver
 * so movie, TV, and subtitle paths share one cache and error taxonomy.
 */
import type { Subtitle } from '@omss/framework';
import type { AddonManager } from '../addons/manager.js';
import type { StremioSubtitle } from '../stremio/protocol.js';
import { fetchSubtitles } from '../stremio/client.js';
import { mapSubtitles } from '../stremio/mapper.js';
import { normalizeImdb } from '../stremio/ids.js';
import {
    globalMediaIdentity,
    MediaIdentityError
} from '../media/mediaIdentity.js';
import { globalReliability } from '../reliability/circuit.js';
import { globalConcurrency } from '../concurrency/coordinator.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';

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
    options: SubtitleAggregateOptions & {
        signal?: AbortSignal;
        deadlineMs?: number;
    } = {}
): Promise<SubtitleAggregateResult> {
    const isSeries = query.season != null && query.episode != null;
    const type: 'movie' | 'tv' = isSeries ? 'tv' : 'movie';
    const stremioType = isSeries ? 'series' : 'movie';

    // Resolve IMDb via the shared MediaIdentityService when tmdbId is provided.
    // This keeps one cache across progressive + subtitle.
    let imdb = query.imdbId ? normalizeImdb(query.imdbId) : '';
    let stremioId: string | null = null;
    if (!imdb && query.tmdbId) {
        try {
            const identity = await globalMediaIdentity.resolve(
                type,
                String(query.tmdbId),
                query.season,
                query.episode,
                {
                    signal: options.signal,
                    deadlineMs: options.deadlineMs,
                    allowTmdbFallback: true
                }
            );
            imdb = identity.media.imdbId
                ? normalizeImdb(identity.media.imdbId)
                : '';
            // Fallback: if IMDb still missing but at least one subtitle addon supports tmdb prefix, use tmdb id directly.
            if (!imdb) {
                const anyTmdb = manager
                    .getSubtitleEnabled()
                    .some((a) =>
                        a.capabilities?.subtitles.some(
                            (e) =>
                                e.idPrefixes.includes('tmdb') ||
                                e.idPrefixes.some((p) => p.startsWith('tmdb'))
                        )
                    );
                if (anyTmdb) {
                    stremioId = `tmdb:${query.tmdbId}${isSeries ? `:${query.season}:${query.episode}` : ''}`;
                }
            }
        } catch (err) {
            if (err instanceof MediaIdentityError) {
                // Preserve taxonomy and cancellation — don't swallow TIMEOUT/ABORTED/validation
                if (err.code === 'TIMEOUT') throw err;
                if (err.code === 'ABORTED') throw err;
                if (
                    err.code === 'INVALID_TMDB_ID' ||
                    err.code === 'INVALID_SEASON_EPISODE'
                )
                    throw err;
            }
            // For other TMDB_NOT_FOUND etc, fall through to generic "could not resolve" but preserve message
            if (
                err instanceof MediaIdentityError &&
                err.code === 'TMDB_NOT_FOUND'
            ) {
                return {
                    subtitles: [],
                    addonsQueried: 0,
                    error: err.message
                };
            }
            // ignore and fall through to generic error
        }
    }

    let id: string;
    if (stremioId) {
        id = stremioId;
    } else {
        if (!imdb) {
            return {
                subtitles: [],
                addonsQueried: 0,
                error: 'Could not resolve an IMDb id (provide imdbId, or tmdbId with a TMDB key)'
            };
        }
        id = isSeries ? `${imdb}:${query.season}:${query.episode}` : imdb;
    }

    // Only subtitle-capable addons (capability-aware) participate
    const capable = manager.getSubtitleEnabled();
    // Phase 7 §10.1 — subtitle aggregation draws from its own pool so scrape
    // bursts cannot starve subtitle lookups (and vice versa).
    const raw = await globalConcurrency.withSlot(
        'subtitles',
        () =>
            collectForId(id, stremioType, manager, publicUrl, options, capable),
        { signal: options.signal }
    );
    // Language post-filter (preserve behavior: filter only when query.language supplied)
    if (query.language) {
        const lang = query.language.toLowerCase();
        const filtered = raw.subtitles.filter((s) =>
            s.label.toLowerCase().includes(lang)
        );
        if (filtered.length) return { ...raw, subtitles: filtered };
    }
    return raw;
}

async function collectForId(
    id: string,
    stremioType: string,
    manager: AddonManager,
    publicUrl: string,
    options: SubtitleAggregateOptions & {
        signal?: AbortSignal;
        deadlineMs?: number;
    },
    prefiltered?: ReturnType<AddonManager['getSubtitleEnabled']>
): Promise<SubtitleAggregateResult> {
    const capable = prefiltered ?? manager.getSubtitleEnabled();
    if (options.signal?.aborted)
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const collected: StremioSubtitle[] = [];
    const urlPolicy = manager.urlPolicy();
    // Bounded concurrency, cancellable, with reliability (semaphore/retry/circuit/metrics)
    const concurrency = 4;
    for (let i = 0; i < capable.length; i += concurrency) {
        if (options.signal?.aborted) break;
        const batch = capable.slice(i, i + concurrency);
        await Promise.all(
            batch.map(async (addon) => {
                if (options.signal?.aborted) return;
                const host = (() => {
                    try {
                        return new URL(addon.baseUrl).hostname;
                    } catch {
                        return undefined;
                    }
                })();
                let release: (() => void) | null = null;
                try {
                    // Respect circuit: skip open
                    if (globalReliability.getState(addon.providerId) === 'open')
                        return;
                    if (
                        globalReliability.getState(addon.providerId) ===
                            'half-open' &&
                        !globalReliability.isProbeAllowed(addon.providerId)
                    )
                        return;
                    release = await globalReliability.acquire(
                        addon.providerId,
                        host,
                        options.signal
                    );
                    const start = Date.now();
                    const subs = await globalReliability.withRetry(
                        () =>
                            fetchSubtitles(
                                addon.baseUrl,
                                stremioType,
                                id,
                                12_000,
                                { policy: urlPolicy, signal: options.signal }
                            ),
                        { maxAttempts: 2, baseMs: 120, signal: options.signal }
                    );
                    globalReliability.recordSuccess(
                        addon.providerId,
                        Date.now() - start
                    );
                    collected.push(...subs);
                } catch (err) {
                    if (
                        (err as Error)?.name === 'AbortError' &&
                        options.signal?.aborted
                    )
                        return;
                    const kind = globalReliability.classifyError(err);
                    // Don't count abort as provider failure
                    if (!(
                        (err as Error)?.name === 'AbortError' &&
                        options.signal?.aborted
                    )) {
                        globalReliability.recordFailure(addon.providerId, kind);
                    }
                    /* best-effort per addon */
                } finally {
                    if (release) release();
                }
            })
        );
    }

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

    return { subtitles: out, addonsQueried: capable.length };
}
