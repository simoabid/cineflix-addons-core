/**
 * Stremio Addon Protocol types (subset used by addons-core).
 *
 * Reference: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/
 * We only model manifest + stream + subtitle responses — the resources needed to
 * turn an addon into a movie/TV source provider.
 */

export type StremioContentType = 'movie' | 'series' | 'tv' | 'channel' | string;

export interface StremioManifestCatalog {
    type: string;
    id: string;
    name?: string;
    extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
}

/**
 * A resource can be a plain string ('stream') or a detailed object with the
 * types / idPrefixes it applies to.
 */
export type StremioResource =
    | string
    | {
          name: string;
          types?: string[];
          idPrefixes?: string[];
      };

export interface StremioManifest {
    id: string;
    version?: string;
    name: string;
    description?: string;
    logo?: string;
    background?: string;
    types?: StremioContentType[];
    resources?: StremioResource[];
    catalogs?: StremioManifestCatalog[];
    idPrefixes?: string[];
    /** Non-standard but common: behaviour hints / config flags. */
    behaviorHints?: Record<string, unknown>;
    [key: string]: unknown;
}

/** Proxy headers an addon asks the player/proxy to send upstream. */
export interface StremioProxyHeaders {
    request?: Record<string, string>;
    response?: Record<string, string>;
}

export interface StremioStreamBehaviorHints {
    bingeGroup?: string;
    notWebReady?: boolean;
    proxyHeaders?: StremioProxyHeaders;
    videoHash?: string;
    videoSize?: number;
    filename?: string;
    [key: string]: unknown;
}

/**
 * A single stream returned by an addon's /stream resource.
 * Direct playable streams carry `url`; torrents carry `infoHash` (+ optional
 * fileIdx) and require a debrid/torrent client — not natively web-playable.
 */
export interface StremioStream {
    url?: string;
    ytId?: string;
    infoHash?: string;
    fileIdx?: number;
    externalUrl?: string;
    name?: string;
    title?: string;
    description?: string;
    subtitles?: StremioSubtitle[];
    behaviorHints?: StremioStreamBehaviorHints;
    [key: string]: unknown;
}

export interface StremioStreamResponse {
    streams?: StremioStream[];
    cacheMaxAge?: number;
    [key: string]: unknown;
}

export interface StremioSubtitle {
    id?: string;
    url: string;
    lang: string;
    /** Some addons include an SRT/VTT marker in the url or a `format` field. */
    format?: string;
    [key: string]: unknown;
}

export interface StremioSubtitleResponse {
    subtitles?: StremioSubtitle[];
    cacheMaxAge?: number;
    [key: string]: unknown;
}
