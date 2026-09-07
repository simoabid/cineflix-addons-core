/**
 * Dedicated subtitle aggregation for GET /v1/subtitles.
 *
 * Queries every enabled addon that is subtitle-capable (capability model) and
 * merges results. Uses MediaIdentityService as the single TMDB/IMDb resolver
 * so movie, TV, and subtitle paths share one cache and error taxonomy.
 *
 * Phase 12 §15.2 — better subtitle experience:
 *   - BCP 47/ISO language canonicalization and matching (language.ts)
 *   - explainable match-confidence scoring + ranking (matching.ts)
 *   - accessibility preferences (hearingImpaired: include/avoid/only)
 *   - provenance (originating addon or fallback) preserved per result
 *   - optional trusted fallback provider (fallback.ts) when addons return
 *     nothing — disabled by default, operator-gated
 */
import type { Subtitle } from '@omss/framework';
import type { AddonManager } from '../addons/manager.js';
import type { StremioSubtitle } from '../stremio/protocol.js';
import { fetchSubtitles } from '../stremio/client.js';
import { inferSubtitleFormat } from '../stremio/mapper.js';
import { normalizeImdb } from '../stremio/ids.js';
import {
    globalMediaIdentity,
    MediaIdentityError
} from '../media/mediaIdentity.js';
import { globalReliability } from '../reliability/circuit.js';
import { globalConcurrency } from '../concurrency/coordinator.js';
import type { UrlPolicyOptions } from '../security/urlPolicy.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';
import {
    describeLanguage,
    languageMatches,
    normalizeLanguageTag
} from './language.js';
import { scoreSubtitleMatch } from './matching.js';
import { fetchFallbackSubtitles } from './fallback.js';

export type HearingImpairedPref = 'include' | 'avoid' | 'only';

export interface SubtitleQuery {
    imdbId?: string;
    tmdbId?: string;
    season?: number;
    episode?: number;
    language?: string;
    /** Accessibility preference (Phase 12 §15.2). Default: include. */
    hearingImpaired?: HearingImpairedPref;
}

/** A raw subtitle together with where it came from (provenance). */
export interface CollectedSubtitle {
    sub: StremioSubtitle;
    /** OMSS provider id of the addon, or the fallback provider label. */
    providerId: string;
    origin: 'addon' | 'fallback';
}

/** Ranked + deduped candidate before playback-grant mapping. */
export interface RankedSubtitleEntry {
    collected: CollectedSubtitle;
    score: number;
    reasons: string[];
    hearingImpaired: boolean;
    langCanonical: string;
}

/** OMSS subtitle enriched with §15.2 experience metadata. */
export interface RankedSubtitle extends Subtitle {
    /** Canonical BCP 47 tag, e.g. "en-US" (omitted when unknown). */
    lang?: string;
    /** True for hearing-impaired (SDH/CC) tracks. */
    hearingImpaired?: boolean;
    /** Match-confidence score 0–100 (explainable via reasons in debug). */
    score?: number;
    /** Provenance: originating addon provider id or fallback provider. */
    provenance?: string;
    /** Where this entry came from. */
    origin?: 'addon' | 'fallback';
}

export interface SubtitleAggregateResult {
    subtitles: RankedSubtitle[];
    addonsQueried: number;
    /** Which backends contributed: addons, fallback, or both. */
    source: 'stremio-addons' | 'fallback' | 'mixed';
    fallbackUsed?: boolean;
    error?: string;
}

/** Operator-gated trusted fallback provider (see src/subtitles/fallback.ts). */
export interface SubtitleFallbackConfig {
    enabled: boolean;
    template?: string;
    timeoutMs?: number;
    policy?: UrlPolicyOptions;
}

export interface SubtitleAggregateOptions {
    /** When set, issue short-lived playback grants instead of legacy proxy URLs. */
    grants?: PlaybackGrantStore;
    secureProxy?: boolean;
    /** Trusted fallback provider configuration (Phase 12 §15.2). */
    fallback?: SubtitleFallbackConfig;
    /** Hard cap on returned subtitles (default 50). */
    maxResults?: number;
    /** Release name for match-confidence scoring (e.g. selected stream title). */
    releaseName?: string;
}

// ── Ranking (pure, unit-testable) ────────────────────────────────────────────

export interface RankOptions {
    hearingImpaired?: HearingImpairedPref;
    maxResults?: number;
}

/**
 * Score, accessibility-filter, sort, and dedup collected subtitles.
 *
 * Accessibility prefs are strict: "avoid" excludes hearing-impaired tracks,
 * "only" keeps exclusively those. Language preference prefers matches but
 * degrades gracefully: if at least one candidate matches the requested
 * language, non-matching candidates are dropped; otherwise all are kept so a
 * rare language request never returns empty purely due to bad tags.
 */
export function rankSubtitles(
    collected: CollectedSubtitle[],
    ctx: {
        language?: string;
        season?: number;
        episode?: number;
        releaseName?: string;
    } = {},
    opts: RankOptions = {}
): RankedSubtitleEntry[] {
    const hiPref = opts.hearingImpaired ?? 'include';

    // Language preference: keep matches when any exist (canonical matching).
    let candidates = collected;
    if (ctx.language) {
        const matching = collected.filter((c) =>
            languageMatches(ctx.language!, c.sub.lang)
        );
        if (matching.length > 0) candidates = matching;
    }

    const ranked = candidates.map((entry) => {
        const scored = scoreSubtitleMatch(entry.sub, ctx);
        return {
            collected: entry,
            score: scored.score,
            reasons: scored.reasons,
            hearingImpaired: scored.hearingImpaired,
            langCanonical: scored.langCanonical
        };
    });

    const filtered = ranked.filter((r) => {
        if (hiPref === 'only') return r.hearingImpaired;
        if (hiPref === 'avoid') return !r.hearingImpaired;
        return true;
    });

    // Highest score first; Array#sort is stable so equal scores keep input
    // (addon priority) order.
    filtered.sort((a, b) => b.score - a.score);

    // Dedup by URL keeping the highest-scored occurrence, then cap.
    const seen = new Set<string>();
    const out: RankedSubtitleEntry[] = [];
    const cap = opts.maxResults ?? 50;
    for (const r of filtered) {
        const url = r.collected.sub.url;
        if (!url || !/^https?:\/\//i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(r);
        if (out.length >= cap) break;
    }
    return out;
}

// ── Aggregate ────────────────────────────────────────────────────────────────

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
                    source: 'stremio-addons',
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
                source: 'stremio-addons',
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
        () => collectForId(id, stremioType, manager, options, capable),
        { signal: options.signal }
    );
    // Phase 12 §15.2 — score, accessibility-filter, rank, dedup.
    const maxResults = options.maxResults ?? 50;
    const rankCtx = {
        language: query.language,
        season: query.season,
        episode: query.episode,
        releaseName: options.releaseName
    };
    const rankOpts = { hearingImpaired: query.hearingImpaired, maxResults };
    let ranked = rankSubtitles(raw.collected, rankCtx, rankOpts);

    // Trusted fallback (operator-gated): only when addon aggregation produced
    // nothing after filtering/ranking.
    let fallbackUsed = false;
    if (
        ranked.length === 0 &&
        options.fallback?.enabled &&
        options.fallback.template &&
        !options.signal?.aborted
    ) {
        const fb = await fetchFallbackSubtitles(
            {
                template: options.fallback.template,
                timeoutMs: options.fallback.timeoutMs,
                policy: options.fallback.policy,
                signal: options.signal
            },
            {
                imdbId: imdb || undefined,
                lang: query.language
                    ? normalizeLanguageTag(query.language) || query.language
                    : undefined,
                season: query.season,
                episode: query.episode
            }
        );
        if (fb && fb.subtitles.length > 0) {
            fallbackUsed = true;
            ranked = rankSubtitles(
                fb.subtitles.map((sub): CollectedSubtitle => ({
                    sub,
                    providerId: fb.provider,
                    origin: 'fallback'
                })),
                rankCtx,
                rankOpts
            );
        }
    }

    // ── Map ranked entries to OMSS subtitles with grants + provenance ───────
    const base = publicUrl.replace(/\/$/, '');
    const useGrants = options.secureProxy !== false && options.grants;

    const out: RankedSubtitle[] = [];
    let addonCount = 0;
    let fallbackCount = 0;
    for (const entry of ranked) {
        const s = entry.collected.sub;
        let proxied: string;
        if (useGrants && options.grants) {
            try {
                const grant = await options.grants.issue({
                    url: s.url,
                    providerId: entry.collected.providerId
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
        const langCanonical = entry.langCanonical;
        const label = langCanonical
            ? describeLanguage(langCanonical)
            : s.lang || s.id || 'Unknown';
        out.push({
            url: proxied,
            label,
            format: inferSubtitleFormat(s.url, s.format),
            ...(langCanonical ? { lang: langCanonical } : {}),
            hearingImpaired: entry.hearingImpaired,
            score: entry.score,
            provenance: entry.collected.providerId,
            origin: entry.collected.origin
        });
        if (entry.collected.origin === 'fallback') fallbackCount++;
        else addonCount++;
    }

    const source: SubtitleAggregateResult['source'] =
        fallbackCount > 0 && addonCount === 0
            ? 'fallback'
            : fallbackCount > 0
              ? 'mixed'
              : 'stremio-addons';

    return {
        subtitles: out,
        addonsQueried: raw.addonsQueried,
        source,
        ...(fallbackUsed ? { fallbackUsed: true } : {})
    };
}

// ── Per-addon collection (raw, provenance-tagged) ────────────────────────────

interface CollectResult {
    collected: CollectedSubtitle[];
    addonsQueried: number;
}

async function collectForId(
    id: string,
    stremioType: string,
    manager: AddonManager,
    options: SubtitleAggregateOptions & {
        signal?: AbortSignal;
        deadlineMs?: number;
    },
    prefiltered?: ReturnType<AddonManager['getSubtitleEnabled']>
): Promise<CollectResult> {
    const capable = prefiltered ?? manager.getSubtitleEnabled();
    if (options.signal?.aborted)
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const collected: CollectedSubtitle[] = [];
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
                    collected.push(
                        ...subs.map((sub): CollectedSubtitle => ({
                            sub,
                            providerId: addon.providerId,
                            origin: 'addon'
                        }))
                    );
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

    return { collected, addonsQueried: capable.length };
}
