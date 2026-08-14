/**
 * Debrid provider types and contracts.
 *
 * A debrid service turns a torrent (infoHash/magnet) into a direct, cached
 * HTTP(S) stream URL. addons-core uses this to make the torrent-heavy Stremio
 * addon ecosystem (Torrentio, MediaFusion, Comet, …) web-playable.
 *
 * Phase 4 introduces typed resolutions, explainable file selection, capability
 * contracts, error classification, and background transfer support.
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
    /** Whether caller allows initiating an uncached background transfer. Default: false. */
    allowUncached?: boolean;
}

export interface FileCandidate {
    index: number;
    name: string;
    size: number;
    score: number;
    reason: string;
}

export interface FileSelectionResult {
    index: number;
    name: string;
    size: number;
    matchReason: string;
    confidence: number;
    candidates?: FileCandidate[];
}

export interface DebridCapabilities {
    supportsInstantAvailabilityCheck: boolean;
    supportsFileSelection: boolean;
    supportsUncachedTransfers: boolean;
    supportsLinkExpiry: boolean;
}

export type DebridErrorKind =
    | 'auth_failure'
    | 'rate_limited'
    | 'network_error'
    | 'invalid_torrent'
    | 'unsupported'
    | 'provider_down'
    | 'unknown';

export type DebridResolution =
    | {
          kind: 'resolved';
          url: string;
          expiresAt?: Date;
          selectedFile: FileSelectionResult;
          cached: boolean;
      }
    | {
          kind: 'uncached';
          torrentId?: string;
          progress?: number;
          status?: string;
      }
    | {
          kind: 'invalid-torrent';
          reason: string;
      }
    | {
          kind: 'provider-error';
          code: string;
          errorKind: DebridErrorKind;
          retryable: boolean;
          safeMessage: string;
      };

export interface DebridCheckResult {
    ok: boolean;
    user?: string;
    expiresAt?: Date;
    premiumDaysRemaining?: number;
    error?: string;
    errorKind?: DebridErrorKind;
}

export interface DebridResolver {
    readonly id: DebridProviderId;
    readonly name: string;

    /** Returns provider capability flags. */
    getCapabilities(): DebridCapabilities;

    /** Lightweight credential check (used by admin test action). */
    checkCredentials(): Promise<DebridCheckResult>;

    /** Backwards-compatible check() alias. */
    check(): Promise<{ ok: boolean; user?: string; error?: string }>;

    /**
     * Resolve a torrent to a typed resolution result (cached-first).
     */
    resolveCached(input: ResolveInput): Promise<DebridResolution>;

    /** Backwards-compatible resolve() yielding string URL or null. */
    resolve(input: ResolveInput): Promise<string | null>;

    /** Best-effort cleanup for unneeded torrents / transfers. */
    cleanup(torrentId: string): Promise<void>;

    /** Poll an in-progress transfer status using its transfer ID directly. */
    pollTransferStatus?(
        torrentId: string,
        opts?: {
            fileIdx?: number;
            season?: number;
            episode?: number;
            title?: string;
        }
    ): Promise<DebridResolution>;

    /** Classify an error for telemetry and operator alerting. */
    classifyError(err: unknown): DebridErrorKind;

    /** Extract link expiration when upstream provider exposes it. */
    getLinkExpiry?(url: string): Date | undefined;
}
