/**
 * StremioAddonProvider — wraps a single installed Stremio addon as an OMSS
 * `BaseProvider`. One instance is registered per enabled addon, so each addon
 * shows up individually in `/v1/providers` and the frontend waterfall can query
 * them one-by-one (best → worst).
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
import { mapStreamsToSources, mapSubtitles } from './mapper.js';
import { resolveTorrentStreams } from '../debrid/torrentSources.js';

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

    constructor(opts: {
        providerId: string;
        name: string;
        baseUrl: string;
        manifest: StremioManifest;
        enabled?: boolean;
        streamTimeoutMs?: number;
    }) {
        super();
        this.id = opts.providerId;
        this.name = opts.name;
        this.BASE_URL = opts.baseUrl;
        this.enabled = opts.enabled ?? true;
        this.manifest = opts.manifest;
        this.supportsSubtitles = hasResource(opts.manifest, 'subtitles');
        this.streamTimeoutMs = opts.streamTimeoutMs ?? 20_000;
        this.capabilities = {
            supportedContentTypes: deriveCapabilities(opts.manifest)
        };
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.resolve(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.resolve(media);
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
        const proxy = (url: string, headers?: Record<string, string>) =>
            headers
                ? this.createProxyUrl(url, headers)
                : this.createProxyUrl(url);

        for (const id of candidates) {
            try {
                const streams = await fetchStreams(
                    this.BASE_URL,
                    stremioType,
                    id,
                    this.streamTimeoutMs
                );
                if (!streams.length) continue;

                const httpSources = mapStreamsToSources(
                    streams,
                    this.id,
                    this.name,
                    proxy
                );
                const torrentSources = await resolveTorrentStreams(
                    streams,
                    this.id,
                    this.name,
                    proxy,
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
                    proxy
                );

                if (sources.length === 0) {
                    // Streams existed but none were playable (uncached torrents,
                    // external players, …) and debrid resolved nothing.
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
        id: string,
        proxy: (url: string, headers?: Record<string, string>) => string
    ): Promise<Subtitle[]> {
        const collected: import('./protocol.js').StremioSubtitle[] = [];

        // Subtitles embedded on the streams themselves.
        for (const s of streams) {
            if (Array.isArray(s.subtitles)) collected.push(...s.subtitles);
        }

        // Dedicated /subtitles resource if the addon advertises it.
        if (this.supportsSubtitles) {
            try {
                const subs = await fetchSubtitles(this.BASE_URL, stremioType, id);
                collected.push(...subs);
            } catch {
                /* subtitles are best-effort */
            }
        }

        return mapSubtitles(collected, proxy);
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
