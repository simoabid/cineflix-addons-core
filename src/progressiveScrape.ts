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

export async function buildProgressiveMedia(
    type: 'movie' | 'tv',
    tmdbId: string,
    season?: number,
    episode?: number,
    opts: MediaIdentityOptions = {}
): Promise<ProviderMediaObject> {
    const res = await globalMediaIdentity.resolve(type, tmdbId, season, episode, opts);
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

    // If a selection service is wired, verify the provider is still selected
    // for this media (defense against stale cached providerId after reorder).
    // We do not hard-block here; we surface a diagnostic if filtered.
    let revision = 0;
    if (opts.selection) {
        revision = opts.selection.revision;
        const selected = opts.selection.selectStreamProviders(media);
        if (!selected.some((a) => a.providerId === providerId)) {
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
    const remaining = deadlineMs ? Math.max(0, deadlineMs - Date.now()) : timeoutMs;
    const effectiveTimeout = Math.min(timeoutMs, remaining || timeoutMs);
    // Create a timeout signal that aborts the underlying fetch so it doesn't keep running after the race
    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => {
        try { timeoutCtrl.abort(Object.assign(new Error(`${provider.name} timed out after ${effectiveTimeout}ms`), { name: 'TimeoutError' })); } catch { /* ignore */ }
    }, effectiveTimeout);
    const combinedSignal = opts.signal
        ? (() => {
            try { return AbortSignal.any([opts.signal, timeoutCtrl.signal]); } catch { return timeoutCtrl.signal; }
          })()
        : timeoutCtrl.signal;

    try {
        if (combinedSignal.aborted) throw Object.assign(new Error(`${provider.name} aborted`), { name: 'AbortError' });
        const getSources = media.type === 'movie'
            ? (provider as unknown as { getMovieSources: (m: ProviderMediaObject, s?: AbortSignal) => Promise<unknown> }).getMovieSources.bind(provider)
            : (provider as unknown as { getTVSources: (m: ProviderMediaObject, s?: AbortSignal) => Promise<unknown> }).getTVSources.bind(provider);
        const result = (await getSources(media as never, combinedSignal)) as { sources: unknown[]; subtitles: unknown[]; diagnostics: unknown[] };
        return {
            sources: Array.isArray(result.sources) ? result.sources : [],
            subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
            diagnostics: Array.isArray(result.diagnostics)
                ? result.diagnostics
                : [],
            providerId: provider.id,
            providerName: provider.name,
            durationMs: Date.now() - start,
            revision
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
            durationMs: Date.now() - start,
            revision
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

/** `/v1/providers` payload — exposed with capabilities and revision. */
export function listProvidersWithPriority(
    manager: AddonManager,
    selection?: ProviderSelectionService
): Array<{
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    tier: string | null;
    capabilities?: unknown;
    revision: number;
}> {
    const rev = selection?.revision ?? manager.getRevision();
    const ordered = selection
        ? sortProvidersForDisplay(manager, selection)
        : manager.list().map((a, i) => ({ a, pri: i }));
    return ordered.map(({ a, pri }) => ({
        id: a.providerId,
        name: a.name,
        enabled: a.enabled,
        priority: pri,
        tier: null,
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
        revision: rev
    }));
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
