/**
 * StremioAddonProvider — wraps a single installed Stremio addon as an OMSS
 * `BaseProvider`. One instance is registered per enabled addon, so each addon
 * shows up individually in `/v1/providers` and the frontend waterfall can query
 * them one-by-one (best → worst).
 *
 * When a PlaybackGrantStore is wired, source/subtitle URLs are issued as
 * short-lived `/v1/proxy/grant/:id` links instead of the legacy open
 * `/v1/proxy?data=` payloads.
 */
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Diagnostic,
    Subtitle
} from '@omss/framework';
import type { StremioManifest } from './protocol.js';
import { fetchStreams, fetchSubtitles } from './client.js';
import { buildIdCandidates, toStremioType } from './ids.js';
import { mapSubtitles, type ProxyFn } from './mapper.js';
import { resolveTorrentStreams } from '../debrid/torrentSources.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';
import { deriveCapabilities as deriveAddonCapabilities } from '../capabilities/index.js';
import { globalSourceNormalization } from '../sources/normalization.js';
import { globalReliability } from '../reliability/circuit.js';
import { globalConcurrency } from '../concurrency/coordinator.js';
import { globalProviderBudgets } from '../capacity/budgets.js';

function deriveCapabilities(
    manifest: StremioManifest
): ProviderCapabilities['supportedContentTypes'] {
    const caps = deriveAddonCapabilities(manifest);
    const out = new Set<'movies' | 'tv'>();
    // Use stream entries' mediaTypes to decide OMSS capabilities; fall back to manifest types
    if (caps.stream.length > 0) {
        for (const e of caps.stream) {
            for (const m of e.mediaTypes) {
                if (m === 'movie') out.add('movies');
                if (m === 'series' || m === 'tv') out.add('tv');
            }
        }
    } else {
        const types = manifest.types;
        if (!Array.isArray(types) || types.length === 0)
            return ['movies', 'tv'];
        for (const t of types) {
            if (t === 'movie') out.add('movies');
            if (t === 'series' || t === 'tv') out.add('tv');
        }
    }
    return out.size ? [...out] : ['movies', 'tv'];
}

export class StremioAddonProvider extends BaseProvider {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly BASE_URL: string;
    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };
    readonly capabilities: ProviderCapabilities;

    private readonly manifest: StremioManifest;
    private readonly supportsSubtitles: boolean;
    private readonly streamTimeoutMs: number;
    private readonly grants?: PlaybackGrantStore;
    private readonly publicBase?: string;
    private readonly secureProxy: boolean;
    private readonly urlPolicy?: import('../security/urlPolicy.js').UrlPolicyOptions;
    private readonly reliability = globalReliability;

    /** Cache of last issued grant URLs so async grant issue can be sync-shaped. */
    private pendingProxy: ProxyFn;

    constructor(opts: {
        providerId: string;
        name: string;
        baseUrl: string;
        manifest: StremioManifest;
        enabled?: boolean;
        streamTimeoutMs?: number;
        grants?: PlaybackGrantStore;
        publicBase?: string;
        secureProxy?: boolean;
        urlPolicy?: import('../security/urlPolicy.js').UrlPolicyOptions;
    }) {
        super();
        this.id = opts.providerId;
        this.name = opts.name;
        this.BASE_URL = opts.baseUrl;
        this.enabled = opts.enabled ?? true;
        this.manifest = opts.manifest;
        const addonCaps = deriveAddonCapabilities(opts.manifest);
        this.supportsSubtitles = addonCaps.subtitles.length > 0;
        this.streamTimeoutMs = opts.streamTimeoutMs ?? 20_000;
        this.grants = opts.grants;
        this.publicBase = opts.publicBase;
        this.secureProxy = opts.secureProxy !== false;
        this.urlPolicy = opts.urlPolicy;
        this.capabilities = {
            supportedContentTypes: deriveCapabilities(opts.manifest)
        };

        // Default: fall back to framework createProxyUrl (legacy) only when
        // secure proxy is explicitly off. Otherwise callers must use the
        // async grant path via buildProxyFn().
        this.pendingProxy = (url: string, headers?: Record<string, string>) => {
            if (!this.secureProxy || !this.grants || !this.publicBase) {
                return headers
                    ? this.createProxyUrl(url, headers)
                    : this.createProxyUrl(url);
            }
            // Synchronous fallback should not be reached when using
            // resolveWithGrants; return a deliberate error URL rather than
            // an open proxy payload.
            return `${this.publicBase}/v1/proxy/grant/pending`;
        };
    }

    async getMovieSources(
        media: ProviderMediaObject,
        signal?: AbortSignal
    ): Promise<ProviderResult> {
        return this.resolve(media, signal);
    }

    async getTVSources(
        media: ProviderMediaObject,
        signal?: AbortSignal
    ): Promise<ProviderResult> {
        return this.resolve(media, signal);
    }

    /**
     * Build a ProxyFn that issues real grants. Because mapStreamsToSources is
     * synchronous, we pre-issue grants for known URLs, or use a queue that
     * the async resolve path drains by mapping in two passes.
     */
    private async proxyUrl(
        url: string,
        headers?: Record<string, string>
    ): Promise<string> {
        if (!this.secureProxy || !this.grants || !this.publicBase) {
            return headers
                ? this.createProxyUrl(url, headers)
                : this.createProxyUrl(url);
        }
        try {
            const grant = await this.grants.issue({
                url,
                headers,
                providerId: this.id
            });
            return this.grants.toProxyUrl(grant, this.publicBase);
        } catch {
            // Policy rejection — omit the source by returning empty; mapper
            // still emits it, so better to fall through without a usable URL.
            // Callers filter empty.
            return '';
        }
    }

    private async resolve(
        media: ProviderMediaObject,
        signal?: AbortSignal
    ): Promise<ProviderResult> {
        if (signal?.aborted)
            throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        const stremioType = toStremioType(media.type);
        const candidates = buildIdCandidates(this.manifest, media);

        if (candidates.length === 0) {
            // Classify as no_compatible_id for negative-cache
            this.reliability.recordFailure(this.id, 'no_compatible_id');
            return this.emptyResult(
                'No usable id (addon needs an IMDb/TMDB id it supports)'
            );
        }

        // Short-circuit if circuit open and negative-cache says no result recently
        const circuit = this.reliability.getState(this.id);
        if (circuit === 'open') {
            return {
                sources: [],
                subtitles: [],
                diagnostics: [
                    {
                        code: 'PROVIDER_ERROR',
                        message: `${this.name}: circuit open — temporarily skipped`,
                        field: '',
                        severity: 'warning'
                    }
                ]
            };
        }

        // Phase 7 §10.4 — quarantined providers never serve traffic (the
        // selection service filters them too; this is the defense in depth).
        if (this.reliability.isQuarantined(this.id)) {
            const q = this.reliability.getQuarantine(this.id);
            return this.emptyResult(
                `quarantined: ${q?.reason ?? 'repeated failures'}`
            );
        }

        const diagnostics: Diagnostic[] = [];
        const dedupSeen = new Set<string>();

        for (const id of candidates) {
            if (signal?.aborted)
                throw Object.assign(new Error('Aborted'), {
                    name: 'AbortError'
                });
            // Short negative cache: if last attempt for this exact id was "no stream" very recently, skip
            if (
                this.reliability.hasNegative(this.id, 'no_stream') &&
                this.reliability.hasNegative(
                    `${this.id}:${id}`,
                    'no_stream' as never
                )
            ) {
                continue;
            }
            // Phase 7 §10.4 — per-provider daily call budget guard.
            const budget = globalProviderBudgets.consume(this.id);
            if (!budget.allowed) {
                return this.emptyResult(
                    `daily call budget exhausted (${budget.limit}/day, resets ${new Date(budget.resetAt ?? 0).toISOString()})`
                );
            }
            // Half-open single-trial gate
            const state = this.reliability.getState(this.id);
            if (
                state === 'half-open' &&
                !this.reliability.isProbeAllowed(this.id)
            ) {
                continue;
            }

            const host = (() => {
                try {
                    return new URL(this.BASE_URL).hostname;
                } catch {
                    return undefined;
                }
            })();

            let release: (() => void) | null = null;
            const start = Date.now();
            try {
                if (signal?.aborted)
                    throw Object.assign(new Error('Aborted'), {
                        name: 'AbortError'
                    });
                // Per-provider + per-host concurrency gate — cancellable
                release = await this.reliability.acquire(this.id, host, signal);
                const latencyStart = Date.now();

                // Retry only transient failures — cancellable; stream calls
                // draw from the provider-stream pool (Phase 7 §10.1).
                const streams = await this.reliability.withRetry(
                    () =>
                        globalConcurrency.withSlot(
                            'provider-stream',
                            () =>
                                fetchStreams(
                                    this.BASE_URL,
                                    stremioType,
                                    id,
                                    this.streamTimeoutMs,
                                    { policy: this.urlPolicy, signal }
                                ),
                            { signal }
                        ),
                    { maxAttempts: 2, baseMs: 150, signal }
                );

                const latency = Date.now() - latencyStart;

                if (!streams.length) {
                    this.reliability.recordFailure(
                        this.id,
                        'no_stream',
                        latency
                    );
                    // Remember per-id negative cache
                    // (use a side map via negative cache key trick)
                    (
                        this.reliability as unknown as {
                            negative: Map<string, unknown>;
                        }
                    ).negative.set(`${this.id}:${id}:no_stream`, {
                        expiresAt: Date.now() + 30_000
                    });
                    continue;
                }

                this.reliability.recordSuccess(this.id, latency);

                const responseCacheMaxAge = (
                    streams as unknown as { cacheMaxAge?: number }
                ).cacheMaxAge;
                // Source normalization: http direct streams via centralized service
                // Provides typing, quality, hdr, codec, dedup, stable ids, grant creation.
                // Pass probe=true to enable bounded HEAD/range validation without full download.
                const httpSources = await globalSourceNormalization.normalize(
                    // Only pass playable http streams; torrents handled separately below
                    streams.filter((s) => s.url && /^https?:\/\//i.test(s.url)),
                    {
                        providerId: this.id,
                        providerName: this.name,
                        grants: this.secureProxy ? this.grants : undefined,
                        publicBase: this.publicBase,
                        dedupSeen,
                        probe: true,
                        signal,
                        responseCacheMaxAge
                    }
                );

                const torrentSources = await resolveTorrentStreams(
                    streams,
                    this.id,
                    this.name,
                    async (url, headers) => this.proxyUrl(url, headers),
                    {
                        season: media.type === 'tv' ? media.s : undefined,
                        episode: media.type === 'tv' ? media.e : undefined,
                        title: media.title
                    }
                );
                const sources = [...httpSources, ...torrentSources];

                const subtitles = await this.collectSubtitles(
                    streams,
                    stremioType,
                    id,
                    signal
                );

                if (sources.length === 0) {
                    diagnostics.push({
                        code: 'PROVIDER_ERROR',
                        message: `${this.name}: ${streams.length} stream(s) but none playable (torrent/external; enable debrid to unlock torrents)`,
                        field: '',
                        severity: 'info'
                    });
                    continue;
                }

                this.console.log(
                    `Resolved ${sources.length} playable source(s) via id ${id}` +
                        (torrentSources.length
                            ? ` (${torrentSources.length} via debrid)`
                            : '')
                );
                return { sources, subtitles, diagnostics };
            } catch (err) {
                const isAbort =
                    (err as Error)?.name === 'AbortError' ||
                    (err as Error)?.name === 'TimeoutError';
                const latency = Date.now() - start;
                // Don't penalize circuit for user-initiated abort/cancellation
                if (!(isAbort && signal?.aborted)) {
                    const kind = this.reliability.classifyError(err);
                    this.reliability.recordFailure(this.id, kind, latency);
                }
                if (isAbort && signal?.aborted) {
                    // Propagate abort so outer deadline handling can stop further IDs
                    throw err;
                }
                const message =
                    err instanceof Error ? err.message : 'Unknown error';
                diagnostics.push({
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                });
            } finally {
                if (release) release();
            }
        }

        return { sources: [], subtitles: [], diagnostics };
    }

    private async collectSubtitles(
        streams: import('./protocol.js').StremioStream[],
        stremioType: string,
        id: string,
        signal?: AbortSignal
    ): Promise<Subtitle[]> {
        const collected: import('./protocol.js').StremioSubtitle[] = [];

        for (const s of streams) {
            if (Array.isArray(s.subtitles)) collected.push(...s.subtitles);
        }

        if (this.supportsSubtitles) {
            if (signal?.aborted) return [];
            // Wrap subtitle fetch in same reliability policy as streams (single trial)
            if (this.reliability.getState(this.id) === 'open') {
                // Skip if circuit open
            } else if (
                this.reliability.getState(this.id) === 'half-open' &&
                !this.reliability.isProbeAllowed(this.id)
            ) {
                // Another half-open trial in flight
            } else {
                let release: (() => void) | null = null;
                try {
                    const host = (() => {
                        try {
                            return new URL(this.BASE_URL).hostname;
                        } catch {
                            return undefined;
                        }
                    })();
                    release = await this.reliability.acquire(
                        this.id,
                        host,
                        signal
                    );
                    const start = Date.now();
                    const subs = await this.reliability.withRetry(
                        () =>
                            fetchSubtitles(
                                this.BASE_URL,
                                stremioType,
                                id,
                                12_000,
                                { policy: this.urlPolicy, signal }
                            ),
                        { maxAttempts: 2, baseMs: 120, signal }
                    );
                    this.reliability.recordSuccess(this.id, Date.now() - start);
                    collected.push(...subs);
                } catch (err) {
                    if (
                        (err as Error)?.name === 'AbortError' &&
                        signal?.aborted
                    ) {
                        // cancellation — don't record as failure
                    } else {
                        const kind = this.reliability.classifyError(err);
                        this.reliability.recordFailure(this.id, kind);
                    }
                    /* subtitles are best-effort */
                } finally {
                    if (release) release();
                }
            }
        }

        // Issue grants per subtitle URL.
        const out: Subtitle[] = [];
        const seen = new Set<string>();
        for (const s of collected) {
            if (!s?.url || !/^https?:\/\//i.test(s.url)) continue;
            if (seen.has(s.url)) continue;
            seen.add(s.url);
            const proxied = await this.proxyUrl(s.url);
            if (!proxied) continue;
            const mapped = mapSubtitles([s], () => proxied);
            out.push(...mapped);
        }
        return out;
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'warning'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        return this.enabled;
    }
}
