/**
 * FederationService — Phase 12 §15.3 (multi-backend aggregation).
 *
 * Aggregates sources from remote OMSS backends into the same normalized
 * source model the local addon waterfall produces, so the frontend can talk
 * to this server alone:
 *
 *   - one normalized source model (OMSS `Source`)
 *   - namespaced provider ids (`backend:<name>`) — never collide with
 *     `addon:<slug>` providers
 *   - per-backend health via the shared reliability registry (independent
 *     circuit breaker per backend, keyed by the namespaced id)
 *   - per-backend daily call budget (capacity registry, same key)
 *   - per-backend priority ordering (lower = higher precedence)
 *   - global cross-backend source deduplication (normalized upstream URL)
 *
 * All outbound calls go through `secureFetchJson` (SSRF policy, redirects
 * revalidated, size/time bounded). Backend bearer tokens are only sent in
 * the Authorization header — never logged, audited, or echoed.
 *
 * Sources returned by a backend are already playable through that backend's
 * own proxy grants; they are passed through verbatim apart from provider
 * namespacing, so no cross-backend secret ever touches this process.
 */

import type { Source } from '@omss/framework';
import type { FederatedBackend } from '../config.js';
import type { UrlPolicyOptions } from '../security/urlPolicy.js';
import {
    secureFetchJson,
    isPolicyOrSecureError
} from '../security/secureFetch.js';
import { globalReliability } from '../reliability/circuit.js';
import { globalProviderBudgets } from '../capacity/budgets.js';
import { normalizeUpstreamUrl } from '../sources/normalization.js';

/** OMSS SourceResponse shape served by `GET /v1/movies/:id` and TV. */
interface BackendSourceResponse {
    responseId?: string;
    sources?: Source[];
    expiresAt?: string;
}

export interface FederationMediaQuery {
    type: 'movie' | 'series';
    /** OMSS media id: `tmdb:<id>` for movies. */
    omdbId: string;
    season?: number;
    episode?: number;
}

export interface BackendStatus {
    id: string;
    name: string;
    baseUrl: string;
    priority: number;
    hasToken: boolean;
    circuit: string;
    metrics: ReturnType<typeof globalReliability.getMetrics>;
    budgetExhausted: boolean;
}

export interface FederationResult {
    sources: Source[];
    backendsQueried: number;
    backendsSkipped: { backendId: string; reason: string }[];
    backendsFailed: { backendId: string; error: string }[];
    duplicatesDropped: number;
}

export interface FederationFetchOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Skip circuit/budget checks (used by health diagnostics). */
    force?: boolean;
}

function backendPath(base: string, q: FederationMediaQuery): string {
    if (q.type === 'series') {
        return `${base}/v1/tv/${encodeURIComponent(q.omdbId)}/seasons/${q.season}/episodes/${q.episode}`;
    }
    return `${base}/v1/movies/${encodeURIComponent(q.omdbId)}`;
}

export class FederationService {
    constructor(
        private readonly backends: FederatedBackend[],
        private readonly defaultTimeoutMs = 10_000,
        /** SSRF policy from the central config (dev suffix/HTTP exemptions). */
        private readonly policy?: UrlPolicyOptions
    ) {}

    get enabled(): boolean {
        return this.backends.length > 0;
    }

    /** Namespaced provider id for a backend (`backend:<name>`). */
    static backendId(name: string): string {
        return `backend:${name}`;
    }

    /** Diagnostics: per-backend circuit, latency, and budget state. */
    getStatus(): BackendStatus[] {
        return [...this.backends]
            .sort((a, b) => a.priority - b.priority)
            .map((b) => {
                const id = FederationService.backendId(b.name);
                return {
                    id,
                    name: b.name,
                    baseUrl: b.baseUrl,
                    priority: b.priority,
                    hasToken: Boolean(b.token),
                    circuit: globalReliability.getState(id),
                    metrics: globalReliability.getMetrics(id),
                    budgetExhausted: globalProviderBudgets.isExhausted(id)
                };
            });
    }

    /**
     * Query every enabled backend for the given media and merge results.
     *
     * Backends are probed in priority order (lower first). Each backend has
     * its own circuit breaker and daily budget, keyed by the namespaced id
     * `backend:<name>` — an unhealthy backend never blocks healthy ones.
     * Results are deduplicated globally by normalized upstream URL so two
     * backends exposing the same upstream only surface once (first by
     * backend priority wins).
     */
    async fetchSources(
        query: FederationMediaQuery,
        opts: FederationFetchOptions = {}
    ): Promise<FederationResult> {
        const ordered = [...this.backends].sort(
            (a, b) => a.priority - b.priority
        );
        const sources: Source[] = [];
        const backendsSkipped: FederationResult['backendsSkipped'] = [];
        const backendsFailed: FederationResult['backendsFailed'] = [];
        let backendsQueried = 0;
        let duplicatesDropped = 0;

        const seen = new Set<string>();

        for (const backend of ordered) {
            if (opts.signal?.aborted) break;
            const id = FederationService.backendId(backend.name);

            // Per-backend policy gates (skippable for diagnostics).
            if (!opts.force) {
                if (!globalReliability.isProbeAllowed(id)) {
                    backendsSkipped.push({
                        backendId: id,
                        reason: 'circuit-open'
                    });
                    continue;
                }
                if (globalProviderBudgets.isExhausted(id)) {
                    backendsSkipped.push({
                        backendId: id,
                        reason: 'budget-exhausted'
                    });
                    continue;
                }
            }

            const started = Date.now();
            try {
                const { data } = await secureFetchJson<BackendSourceResponse>(
                    backendPath(backend.baseUrl, query),
                    {
                        method: 'GET',
                        timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
                        signal: opts.signal,
                        maxBytes: 4_194_304,
                        // Central SSRF policy (blocks private ranges unless
                        // the config explicitly grants dev exemptions).
                        ...(this.policy ? { policy: this.policy } : {}),
                        headers: {
                            // Bearer token only in the Authorization header —
                            // never in query strings, logs, or audits.
                            ...(backend.token
                                ? { Authorization: `Bearer ${backend.token}` }
                                : {})
                        }
                    }
                );

                backendsQueried++;
                globalReliability.recordSuccess(id, Date.now() - started);
                globalProviderBudgets.consume(id);

                const incoming = Array.isArray(data?.sources)
                    ? data.sources
                    : [];
                for (const src of incoming) {
                    // One normalized model: require a URL, namespace the
                    // provider id so `backend:x` can never collide with
                    // `addon:<slug>`.
                    if (!src?.url) continue;
                    const key = normalizeUpstreamUrl(src.url);
                    if (seen.has(key)) {
                        duplicatesDropped++;
                        continue;
                    }
                    seen.add(key);
                    sources.push({
                        ...src,
                        provider: {
                            id,
                            name: `${src.provider?.name ?? backend.name} (federated)`
                        }
                    });
                }
            } catch (err) {
                if (
                    (err as Error)?.name === 'AbortError' &&
                    opts.signal?.aborted
                ) {
                    break;
                }
                // Policy/SSRF rejections are not backend faults — skip
                // silently instead of tripping the backend's circuit.
                if (isPolicyOrSecureError(err)) {
                    backendsSkipped.push({
                        backendId: id,
                        reason: (err as Error).message
                    });
                    continue;
                }
                globalReliability.recordFailure(
                    id,
                    globalReliability.classifyError(err)
                );
                backendsFailed.push({
                    backendId: id,
                    error: (err as Error)?.message ?? String(err)
                });
            }
        }

        return {
            sources,
            backendsQueried,
            backendsSkipped,
            backendsFailed,
            duplicatesDropped
        };
    }
}
