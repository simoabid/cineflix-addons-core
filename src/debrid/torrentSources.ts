/**
 * Turn torrent (`infoHash`) Stremio streams into playable OMSS sources by
 * resolving them through the configured debrid service. No-op (empty) when
 * debrid is disabled, so behaviour is unchanged for direct-HTTP addons.
 */
import type { Source } from '@omss/framework';
import type { StremioStream } from '../stremio/protocol.js';
import {
    inferQuality,
    inferTypeFromUrl,
    type ProxyFn
} from '../stremio/mapper.js';
import { debridService } from './service.js';

export function isTorrentStream(s: StremioStream): boolean {
    return typeof s.infoHash === 'string' && s.infoHash.length > 0 && !s.url;
}

/** Cap how many torrents we try per addon so a query stays snappy. */
const MAX_TORRENTS = 12;
const CONCURRENCY = 4;

export interface TorrentResolveContext {
    season?: number;
    episode?: number;
    title?: string;
}

/** Sync or async proxy URL builder (grants are async). */
export type AsyncProxyFn = (
    url: string,
    headers?: Record<string, string>
) => string | Promise<string>;

function torrentLabel(stream: StremioStream): string {
    const raw = (stream.title || stream.name || '').replace(/\s+/g, ' ').trim();
    return raw.split('\n')[0].slice(0, 70) || 'Torrent';
}

export async function resolveTorrentStreams(
    streams: StremioStream[],
    providerId: string,
    providerName: string,
    proxy: ProxyFn | AsyncProxyFn,
    ctx: TorrentResolveContext
): Promise<Source[]> {
    if (!debridService.isEnabled()) return [];

    const torrents = streams.filter(isTorrentStream).slice(0, MAX_TORRENTS);
    if (torrents.length === 0) return [];

    const sources: Source[] = [];
    for (let i = 0; i < torrents.length; i += CONCURRENCY) {
        const batch = torrents.slice(i, i + CONCURRENCY);
        const resolved = await Promise.all(
            batch.map(async (stream) => {
                try {
                    const res = await debridService.resolveCached({
                        infoHash: stream.infoHash as string,
                        sources: Array.isArray(stream.sources)
                            ? (stream.sources as string[])
                            : undefined,
                        fileIdx: stream.fileIdx,
                        season: ctx.season,
                        episode: ctx.episode,
                        title: ctx.title,
                        allowUncached: false
                    });

                    if (res.kind !== 'resolved' || !res.url) {
                        return null;
                    }

                    const proxied = await Promise.resolve(proxy(res.url));
                    if (!proxied) return null;

                    const label = torrentLabel(stream);
                    const source: Source = {
                        url: proxied,
                        type: inferTypeFromUrl(res.url) ?? 'mp4',
                        quality: inferQuality(stream),
                        audioTracks: [{ language: 'und', label }],
                        provider: {
                            id: providerId,
                            name: `${providerName} (debrid)`
                        }
                    };
                    return source;
                } catch {
                    return null;
                }
            })
        );
        for (const s of resolved) if (s) sources.push(s);
    }
    return sources;
}
