/**
 * Progressive single-provider (single-addon) scrape helpers.
 *
 * Mirrors cineflix-core so the CINEFLIX frontend can waterfall addons
 * best → worst and start playback without waiting for a bulk scrape:
 *   GET /v1/movies/:tmdbId/providers/:providerId
 *   GET /v1/tv/:tmdbId/seasons/:s/episodes/:e/providers/:providerId
 *
 * Media identity is unified via MediaIdentityService (single cache, error
 * taxonomy, abort/deadline propagation). The legacy inline tmdbFetch has been
 * replaced to avoid divergent caching between progressive, bulk, and subtitle
 * paths.
 */
import type { ProviderMediaObject, ProviderRegistry } from '@omss/framework';
import type { AddonManager } from './addons/manager.js';
import type { InstalledAddon } from './addons/types.js';
import {
    globalMediaIdentity,
    type MediaIdentityOptions
} from './media/mediaIdentity.js';
import type { ProviderSelectionService } from './providers/selection.js';
import { globalReliability } from './reliability/circuit.js';
import { globalConcurrency } from './concurrency/coordinator.js';
import { tracer } from './telemetry/index.js';
import { globalMetrics } from './metrics/index.js';

export async function buildProgressiveMedia(
    type: 'movie' | 'tv',
    tmdbId: string,
    season?: number,
    episode?: number,
    opts: MediaIdentityOptions = {}
): Promise<ProviderMediaObject> {
    const res = await globalMediaIdentity.resolve(
        type,
        tmdbId,
        season,
        episode,
        opts
    );
    return res.media;
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
    timeoutMs: number,
    opts: {
        selection?: ProviderSelectionService;
        signal?: AbortSignal;
        deadlineMs?: number;
    } = {}
): Promise<SingleProviderResult & { revision: number }> {
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

    // Phase 7 §10.1 — bounded progressive-scrape admission. The request keeps
    // its own timeout signal so pool saturation fails fast instead of piling
    // unbounded waterfall requests onto the event loop.
    const pool = globalConcurrency.pool('progressive-scrape');
    return pool.withSlot(
        () =>
            tracer.withSpan(
                'provider.scrape',
                async (span) =>
                    scrapeInner(
                        registry,
                        providerId,
                        media,
                        timeoutMs,
                        opts,
                        span
                    ),
                {
                    attributes: {
                        'provider.id': providerId,
                        'media.type': media.type
                    }
                }
            ),
        { signal: opts.signal }
    );
}

async function scrapeInner(
    registry: ProviderRegistry,
    providerId: string,
    media: ProviderMediaObject,
    timeoutMs: number,
    opts: {
        selection?: ProviderSelectionService;
        signal?: AbortSignal;
        deadlineMs?: number;
    },
    span: import('./telemetry/index.js').Span
): Promise<SingleProviderResult & { revision: number }> {
    const provider = registry.getProvider(providerId);
    if (!provider) {
        const err = new Error(`Provider not found: ${providerId}`) as Error & {
            statusCode?: number;
        };
        err.statusCode = 404;
        throw err;
    }
    span.setAttribute('provider.id', providerId);
    span.setAttribute('provider.name', provider.name);
    span.setAttribute('media.type', media.type);
    const mediaId =
        (media as { tmdbId?: string | number; imdbId?: string }).tmdbId ||
        (media as { imdbId?: string }).imdbId ||
        '';
    span.setAttribute('media.id', String(mediaId));

    globalMetrics.recordProviderAttempt(providerId, 'stream');

    // If a selection service is wired, verify the provider is still selected
    // for this media (defense against stale cached providerId after reorder).
    // We do not hard-block here; we surface a diagnostic if filtered.
    let revision = 0;
    if (opts.selection) {
        revision = opts.selection.revision;
        const selected = opts.selection.selectStreamProviders(media);
        if (!selected.some((a) => a.providerId === providerId)) {
            globalMetrics.recordProviderOutcome(
                providerId,
                'no_result',
                0,
                'not_selected'
            );
            span.setAttribute('provider.skipped', true);
            return {
                sources: [],
                subtitles: [],
                diagnostics: [
                    {
                        code: 'PROVIDER_SKIPPED',
                        message: `${provider.name}: not in current selection for this media (type/id not supported or circuit open)`,
                        field: '',
                        severity: 'warning'
                    }
                ],
                providerId: provider.id,
                providerName: provider.name,
                durationMs: 0,
                revision
            };
        }
    }

    const start = Date.now();
    // Compute effective deadline: respect absolute deadline if provided, otherwise provider timeout
    const deadlineMs = opts.deadlineMs;
    const remaining = deadlineMs
        ? Math.max(0, deadlineMs - Date.now())
        : timeoutMs;
    const effectiveTimeout = Math.min(timeoutMs, remaining || timeoutMs);
    // Create a timeout signal that aborts the underlying fetch so it doesn't keep running after the race
    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => {
        try {
            timeoutCtrl.abort(
                Object.assign(
                    new Error(
                        `${provider.name} timed out after ${effectiveTimeout}ms`
                    ),
                    { name: 'TimeoutError' }
                )
            );
        } catch {
            /* ignore */
        }
    }, effectiveTimeout);
    const combinedSignal = opts.signal
        ? (() => {
              try {
                  return AbortSignal.any([opts.signal, timeoutCtrl.signal]);
              } catch {
                  return timeoutCtrl.signal;
              }
          })()
        : timeoutCtrl.signal;

    try {
        if (combinedSignal.aborted)
            throw Object.assign(new Error(`${provider.name} aborted`), {
                name: 'AbortError'
            });
        const getSources =
            media.type === 'movie'
                ? (
                      provider as unknown as {
                          getMovieSources: (
                              m: ProviderMediaObject,
                              s?: AbortSignal
                          ) => Promise<unknown>;
                      }
                  ).getMovieSources.bind(provider)
                : (
                      provider as unknown as {
                          getTVSources: (
                              m: ProviderMediaObject,
                              s?: AbortSignal
                          ) => Promise<unknown>;
                      }
                  ).getTVSources.bind(provider);
        const result = (await getSources(media as never, combinedSignal)) as {
            sources: unknown[];
            subtitles: unknown[];
            diagnostics: unknown[];
        };
        const duration = Date.now() - start;
        const sources = Array.isArray(result.sources) ? result.sources : [];
        const subtitles = Array.isArray(result.subtitles)
            ? result.subtitles
            : [];
        const diagnostics = Array.isArray(result.diagnostics)
            ? result.diagnostics
            : [];

        span.setAttribute('sources.count', sources.length);
        span.setAttribute('subtitles.count', subtitles.length);

        if (sources.length > 0) {
            globalMetrics.recordProviderOutcome(
                providerId,
                'success',
                duration
            );
            globalMetrics.recordSourceExtracted(providerId, sources.length);
        } else {
            globalMetrics.recordProviderOutcome(
                providerId,
                'no_result',
                duration
            );
        }

        return {
            sources,
            subtitles,
            diagnostics,
            providerId: provider.id,
            providerName: provider.name,
            durationMs: duration,
            revision
        };
    } catch (error) {
        const duration = Date.now() - start;
        const message =
            error instanceof Error ? error.message : 'Unknown provider error';
        const isTimeout =
            (error as Error)?.name === 'TimeoutError' ||
            message.includes('timed out');
        const failureKind = globalReliability.classifyError(error);

        globalMetrics.recordProviderOutcome(
            providerId,
            isTimeout ? 'timeout' : 'failure',
            duration,
            failureKind
        );
        span.recordException(error as Error);

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
            durationMs: duration,
            revision
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

/** `/v1/providers` payload — enriched with capabilities, freshness, admission state, and diagnostics. */
export function listProvidersWithPriority(
    manager: AddonManager,
    selection?: ProviderSelectionService
): Array<{
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    tier: string | null;
    admissionState: string;
    capabilities?: unknown;
    health?: {
        healthy: boolean;
        lastChecked?: string;
        isFresh: boolean;
        error?: string;
    };
    diagnostics?: {
        circuitState: 'closed' | 'open' | 'half-open';
        metrics: {
            attempts: number;
            successes: number;
            failures: number;
            latencyAvgMs?: number;
        };
    };
    revision: number;
}> {
    const rev = selection?.revision ?? manager.getRevision();
    const ordered = selection
        ? sortProvidersForDisplay(manager, selection)
        : manager.list().map((a, i) => ({ a, pri: i }));

    const now = Date.now();
    const FRESHNESS_TTL_MS = 60 * 60 * 1000; // 1 hour

    return ordered.map(({ a, pri }) => {
        let isFresh = false;
        if (a.health?.lastChecked) {
            const checkedTime = new Date(a.health.lastChecked).getTime();
            isFresh =
                !isNaN(checkedTime) && now - checkedTime < FRESHNESS_TTL_MS;
        }

        const metrics = globalReliability.getMetrics(a.providerId);
        const circuitState = globalReliability.getState(a.providerId);

        return {
            id: a.providerId,
            name: a.name,
            enabled: a.enabled,
            priority: pri,
            tier: null,
            admissionState:
                a.admissionState ?? (a.enabled ? 'validated' : 'disabled'),
            capabilities: a.capabilities
                ? {
                      stream: a.capabilities.stream,
                      subtitles: a.capabilities.subtitles,
                      catalog: a.capabilities.catalog,
                      meta: a.capabilities.meta,
                      status: a.capabilities.status,
                      statusReason: a.capabilities.statusReason
                  }
                : undefined,
            health: a.health
                ? {
                      healthy: a.health.healthy,
                      lastChecked: a.health.lastChecked,
                      isFresh,
                      error: a.health.error
                  }
                : undefined,
            diagnostics: {
                circuitState,
                metrics: {
                    attempts: metrics?.attempts ?? 0,
                    successes: metrics?.successes ?? 0,
                    failures: metrics?.failures ?? 0,
                    latencyAvgMs: metrics?.avgLatency
                },
                quarantined: globalReliability.isQuarantined(a.providerId)
            },
            revision: rev
        };
    });
}

function sortProvidersForDisplay(
    manager: AddonManager,
    // selection kept for signature parity; ordering currently mirrors manager.list()
    // so catalog-only addons remain visible in the admin UI rather than being hidden.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _selection: ProviderSelectionService
): Array<{ a: InstalledAddon; pri: number }> {
    const all = manager.list();
    return all.map((a, i) => ({ a, pri: i }));
}
