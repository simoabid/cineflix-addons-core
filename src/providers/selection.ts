/**
 * ProviderSelectionService — Phase 2.2
 *
 * The single authoritative component allowed to produce the ordered stream
 * provider list. Filters by enabled state, stream capability, media type,
 * id-prefix compatibility, health/circuit state, and priority.
 *
 * Both progressive and bulk routes must call this service so ordering,
 * registry order, and cache invalidation stay coherent.
 */

import type { ProviderMediaObject } from '@omss/framework';
import type { AddonManager } from '../addons/manager.js';
import type { InstalledAddon } from '../addons/types.js';
import { buildIdCandidates } from '../stremio/ids.js';
import { sortAddons } from '../priority.js';
import type { ReliabilityRegistry } from '../reliability/circuit.js';
import type { ProviderBudgetRegistry } from '../capacity/budgets.js';

export interface SelectionOptions {
    /** Optional explicit allowlist (e.g. user-scoped). */
    allowedIds?: Set<string>;
    /** Whether to include circuit-open providers (default false — skip them). */
    includeCircuitOpen?: boolean;
    /** Whether to include unhealthy providers (default false — skip unhealthy). */
    includeUnhealthy?: boolean;
    /** Include quarantined / budget-exhausted providers (diagnostics only). */
    includeQuarantined?: boolean;
    /** Abort signal for candidate building (pass-through). */
    signal?: AbortSignal;
}

export interface RankedProvider {
    addon: InstalledAddon;
    priority: number;
    reason?: string;
}

export class ProviderSelectionService {
    constructor(
        private readonly manager: AddonManager,
        private readonly reliability?: ReliabilityRegistry,
        /** Phase 7 §10.4 — providers with exhausted daily budgets are skipped. */
        private readonly budgets?: ProviderBudgetRegistry
    ) {}

    get revision(): number {
        return this.manager.getRevision();
    }

    /**
     * Ordered stream providers for the given media, after applying all policy
     * filters. This list drives both progressive (single call) and bulk
     * (aggregate) paths.
     */
    selectStreamProviders(
        media: ProviderMediaObject,
        opts: SelectionOptions = {}
    ): InstalledAddon[] {
        let candidates = this.manager.getStreamEnabled();

        // Filter by explicit allowlist if provided
        if (opts.allowedIds) {
            candidates = candidates.filter((a) =>
                opts.allowedIds!.has(a.providerId)
            );
        }

        // Phase 7 §10.4 — quarantined providers never serve traffic until
        // released (manual or TTL); they stay visible via /debug endpoints.
        if (!opts.includeQuarantined && this.reliability) {
            candidates = candidates.filter(
                (a) => !this.reliability!.isQuarantined(a.providerId)
            );
        }

        // Phase 7 §10.4 — providers whose daily call budget is exhausted are
        // skipped until the UTC-day window resets.
        if (!opts.includeQuarantined && this.budgets) {
            candidates = candidates.filter(
                (a) => !this.budgets!.isExhausted(a.providerId)
            );
        }

        // Filter by circuit state (open = recently failed, skip unless requested)
        if (!opts.includeCircuitOpen && this.reliability) {
            candidates = candidates.filter((a) => {
                const state = this.reliability!.getState(a.providerId);
                // 'open' means skip; 'half-open' we allow one trial, so include
                return state !== 'open';
            });
        }

        // Filter by health state (unhealthy = skip unless explicitly included)
        if (!opts.includeUnhealthy) {
            candidates = candidates.filter((a) => {
                const h = (
                    a as unknown as {
                        health?: { healthy: boolean; lastChecked?: string };
                    }
                ).health;
                if (!h) return true;
                if (h.healthy === false) {
                    // Consider freshness: if lastChecked is stale (>30m), allow retry
                    if (h.lastChecked) {
                        const age =
                            Date.now() - new Date(h.lastChecked).getTime();
                        if (Number.isFinite(age) && age > 30 * 60 * 1000)
                            return true;
                    }
                    return false;
                }
                return true;
            });
        }

        // Filter by media-type support via capabilities
        candidates = candidates.filter((a) => {
            const caps = a.capabilities;
            if (!caps) return true; // no caps = assume ok (should not happen)
            const types = caps.stream.flatMap((e) => e.mediaTypes);
            if (media.type === 'tv') {
                return (
                    types.includes('series' as never) ||
                    types.includes('tv' as never)
                );
            }
            return types.includes('movie' as never);
        });

        // Filter by id-prefix compatibility: at least one candidate ID exists
        candidates = candidates.filter((a) => {
            const ids = buildIdCandidates(a.manifest, media);
            return ids.length > 0;
        });

        // Already sorted by priority via getStreamEnabled -> sortAddons, but ensure stable order
        return sortAddons(candidates);
    }

    /**
     * Rank with diagnostics for privileged callers.
     */
    rankStreamProviders(
        media: ProviderMediaObject,
        opts: SelectionOptions = {}
    ): RankedProvider[] {
        const ordered = this.selectStreamProviders(media, opts);
        return ordered.map((a, i) => ({ addon: a, priority: i }));
    }

    /** Subtitle-capable providers (separate pipeline). */
    selectSubtitleProviders(): InstalledAddon[] {
        return this.manager.getSubtitleEnabled();
    }

    /** All stream providers regardless of media (for /v1/providers list). */
    listStreamProvidersWithMeta(): Array<{
        addon: InstalledAddon;
        priority: number;
        capabilities: InstalledAddon['capabilities'];
        circuitState?: string;
    }> {
        const ordered = sortAddons(this.manager.getStreamEnabled());
        return ordered.map((a, i) => ({
            addon: a,
            priority: i,
            capabilities: a.capabilities,
            circuitState: this.reliability?.getState(a.providerId)
        }));
    }

    /**
     * Aggregate-mode bulk fetch: query eligible providers concurrently with
     * bounded concurrency, return all usable sources in priority order.
     * Callers provide the per-provider fetch function.
     */
    async fetchAggregate<T>(
        media: ProviderMediaObject,
        fetcher: (addon: InstalledAddon) => Promise<T>,
        opts: { concurrency?: number; signal?: AbortSignal } = {}
    ): Promise<
        Array<{ addon: InstalledAddon; result: T | null; error?: string }>
    > {
        const providers = this.selectStreamProviders(media, {
            signal: opts.signal
        });
        const concurrency = opts.concurrency ?? 4;
        const results: Array<{
            addon: InstalledAddon;
            result: T | null;
            error?: string;
        }> = [];

        for (let i = 0; i < providers.length; i += concurrency) {
            if (opts.signal?.aborted) break;
            const batch = providers.slice(i, i + concurrency);
            const settled = await Promise.allSettled(
                batch.map(async (addon) => {
                    try {
                        const r = await fetcher(addon);
                        return { addon, result: r as T, error: undefined };
                    } catch (err) {
                        return {
                            addon,
                            result: null,
                            error:
                                err instanceof Error ? err.message : String(err)
                        };
                    }
                })
            );
            for (const s of settled) {
                if (s.status === 'fulfilled') results.push(s.value);
                else
                    results.push({
                        addon: batch[0],
                        result: null,
                        error: String(s.reason)
                    });
            }
        }

        // Preserve priority order
        const rank = new Map(results.map((r) => [r.addon.providerId, r]));
        return providers.map((p) => rank.get(p.providerId)!).filter(Boolean);
    }

    /**
     * Fast-first mode: query in priority waves and stop after target count/quality.
     * For now quality is simple count-based; richer policy can live in callers.
     */
    async fetchFastFirst<T extends { sources?: unknown[] }>(
        media: ProviderMediaObject,
        fetcher: (addon: InstalledAddon) => Promise<T>,
        opts: {
            targetCount?: number;
            concurrency?: number;
            signal?: AbortSignal;
        } = {}
    ): Promise<Array<{ addon: InstalledAddon; result: T | null }>> {
        const providers = this.selectStreamProviders(media, {
            signal: opts.signal
        });
        const targetCount = opts.targetCount ?? 3;
        const concurrency = opts.concurrency ?? 2;
        const collected: Array<{ addon: InstalledAddon; result: T | null }> =
            [];
        let totalSources = 0;

        for (let i = 0; i < providers.length; i += concurrency) {
            if (opts.signal?.aborted) break;
            if (totalSources >= targetCount) break;
            const batch = providers.slice(i, i + concurrency);
            const batchResults = await Promise.all(
                batch.map(async (addon) => {
                    try {
                        const r = await fetcher(addon);
                        return { addon, result: r };
                    } catch {
                        return { addon, result: null as unknown as T };
                    }
                })
            );
            for (const r of batchResults) {
                collected.push(r);
                totalSources +=
                    (r.result?.sources as unknown[] | undefined)?.length ?? 0;
            }
            if (totalSources >= targetCount) break;
        }
        return collected;
    }
}
