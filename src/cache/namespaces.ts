/**
 * Key namespaces and standard TTLs for addons-core caching subsystem.
 *
 * Key families:
 *   media:v1:<type>:<tmdb-id>:<season>:<episode>
 *   provider-result:v1:<provider-revision>:<media-key>
 *   aggregate-result:v1:<provider-set-revision>:<media-key>
 *   playback-grant:v1:<id>
 *   health:v1:<addon-id>
 *   circuit:v1:<provider-id>
 */

export interface CacheTtlConfig {
    mediaSec: number;
    providerResultSec: number;
    aggregateResultSec: number;
    aggregateSwrSec: number;
    playbackGrantSec: number;
    healthSec: number;
    circuitSec: number;
}

export const DEFAULT_CACHE_TTLS: CacheTtlConfig = {
    mediaSec: 86400, // 24 hours
    providerResultSec: 3600, // 1 hour
    aggregateResultSec: 3600, // 1 hour
    aggregateSwrSec: 300, // 5 minutes stale-while-revalidate grace
    playbackGrantSec: 7200, // 2 hours
    healthSec: 900, // 15 minutes
    circuitSec: 30 // 30 seconds
};

export function buildMediaKey(
    type: 'movie' | 'tv' | string,
    tmdbId: string | number,
    season?: number,
    episode?: number
): string {
    const t = type === 'movie' ? 'movie' : 'tv';
    const id = String(tmdbId).trim();
    if (t === 'tv' && season != null && episode != null) {
        return `media:v1:${t}:${id}:${season}:${episode}`;
    }
    return `media:v1:${t}:${id}:0:0`;
}

export function buildProviderResultKey(
    providerRevision: number | string,
    mediaKey: string
): string {
    return `provider-result:v1:${providerRevision}:${mediaKey}`;
}

export function buildAggregateResultKey(
    providerSetRevision: number | string,
    mediaKey: string
): string {
    return `aggregate-result:v1:${providerSetRevision}:${mediaKey}`;
}

export function buildPlaybackGrantKey(id: string): string {
    return `playback-grant:v1:${id.trim()}`;
}

export function buildHealthKey(addonId: string): string {
    return `health:v1:${addonId.trim()}`;
}

export function buildCircuitKey(providerId: string): string {
    return `circuit:v1:${providerId.trim()}`;
}
