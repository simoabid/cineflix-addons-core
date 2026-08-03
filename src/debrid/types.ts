/**
 * Debrid provider types.
 *
 * A debrid service turns a torrent (infoHash/magnet) into a direct, cached
 * HTTP(S) stream URL. addons-core uses this to make the torrent-heavy Stremio
 * addon ecosystem (Torrentio, MediaFusion, Comet, …) actually web-playable.
 */

export type DebridProviderId =
    | 'none'
    | 'realdebrid'
    | 'alldebrid'
    | 'premiumize';

export interface DebridConfig {
    provider: DebridProviderId;
    apiKey: string;
    /** Where the config came from (env wins over persisted store). */
    source?: 'env' | 'store' | 'none';
}

export interface ResolveInput {
    infoHash: string;
    /** Trackers / sources from the Stremio stream, if provided. */
    sources?: string[];
    /** 0-based file index into the torrent, from the Stremio stream. */
    fileIdx?: number;
    season?: number;
    episode?: number;
    /** Human title (used for display name + logging). */
    title?: string;
}

export interface DebridFile {
    name: string;
    size: number;
    /** Provider-specific handle used to obtain the final link. */
    link?: string;
    index: number;
}

export interface DebridResolver {
    readonly id: DebridProviderId;
    readonly name: string;
    /**
     * Resolve a torrent to a direct HTTP(S) URL, or null when the torrent is
     * not instantly available (uncached) or resolution fails.
     */
    resolve(input: ResolveInput): Promise<string | null>;
    /** Lightweight credential check (used by the admin "test" action). */
    check(): Promise<{ ok: boolean; user?: string; error?: string }>;
}
