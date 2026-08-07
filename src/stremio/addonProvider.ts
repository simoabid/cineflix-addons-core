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
import type { StremioManifest, StremioResource } from './protocol.js';
import { fetchStreams, fetchSubtitles } from './client.js';
import { buildIdCandidates, toStremioType } from './ids.js';
import { mapStreamsToSources, mapSubtitles, type ProxyFn } from './mapper.js';
import { resolveTorrentStreams } from '../debrid/torrentSources.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';

function hasResource(manifest: StremioManifest, name: string): boolean {
    const resources = manifest.resources;
    if (!Array.isArray(resources)) return false;
    return resources.some((r: StremioResource) =>
        typeof r === 'string' ? r === name : r?.name === name
    );
}

function deriveCapabilities(
    manifest: StremioManifest
): ProviderCapabilities['supportedContentTypes'] {
    const types = manifest.types;
    if (!Array.isArray(types) || types.length === 0) {
        return ['movies', 'tv'];
    }
    const out = new Set<'movies' | 'tv'>();
    for (const t of types) {
        if (t === 'movie') out.add('movies');
        if (t === 'series' || t === 'tv') out.add('tv');
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
        this.supportsSubtitles = hasResource(opts.manifest, 'subtitles');
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

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.resolve(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.resolve(media);
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

    private async resolve(media: ProviderMediaObject): Promise<ProviderResult> {
        const stremioType = toStremioType(media.type);
        const candidates = buildIdCandidates(this.manifest, media);

        if (candidates.length === 0) {
            return this.emptyResult(
                'No usable id (addon needs an IMDb/TMDB id it supports)'
            );
        }

        const diagnostics: Diagnostic[] = [];

        for (const id of candidates) {
            try {
                const streams = await fetchStreams(
                    this.BASE_URL,
                    stremioType,
                    id,
                    this.streamTimeoutMs,
                    { policy: this.urlPolicy }
                );
                if (!streams.length) continue;

                // Async-aware mapping: issue grants per stream.
                const httpSources = [];
                for (const stream of streams) {
                    if (!stream.url || !/^https?:\/\//i.test(stream.url))
                        continue;
                    const reqHeaders =
                        stream.behaviorHints?.proxyHeaders?.request;
                    const proxied = await this.proxyUrl(stream.url, reqHeaders);
                    if (!proxied) continue;
                    // Reuse mapper heuristics via a one-shot proxy fn.
                    const one: ProxyFn = () => proxied;
                    const mapped = mapStreamsToSources(
                        [stream],
                        this.id,
                        this.name,
                        one
                    );
                    httpSources.push(...mapped);
                }

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
                    id
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
                const message =
                    err instanceof Error ? err.message : 'Unknown error';
                diagnostics.push({
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                });
            }
        }

        return { sources: [], subtitles: [], diagnostics };
    }

    private async collectSubtitles(
        streams: import('./protocol.js').StremioStream[],
        stremioType: string,
        id: string
    ): Promise<Subtitle[]> {
        const collected: import('./protocol.js').StremioSubtitle[] = [];

        for (const s of streams) {
            if (Array.isArray(s.subtitles)) collected.push(...s.subtitles);
        }

        if (this.supportsSubtitles) {
            try {
                const subs = await fetchSubtitles(
                    this.BASE_URL,
                    stremioType,
                    id,
                    12_000,
                    { policy: this.urlPolicy }
                );
                collected.push(...subs);
            } catch {
                /* subtitles are best-effort */
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
