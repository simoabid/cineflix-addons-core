import type { StremioManifest } from '../stremio/protocol.js';
import type { DebridProviderId } from '../debrid/types.js';
import type { AddonCapabilities } from '../capabilities/index.js';

export interface AppSettings {
    debrid: {
        provider: DebridProviderId;
        /** May be envelope-encrypted at rest (`enc:v1:…`). */
        apiKey: string;
    };
}

export function defaultSettings(): AppSettings {
    return { debrid: { provider: 'none', apiKey: '' } };
}

/**
 * Addon admission lifecycle (phase 1 security).
 * New production imports start as `pending`/`validated` and disabled until an
 * operator explicitly enables them.
 */
export type AddonAdmissionState =
    'pending' | 'validated' | 'disabled' | 'quarantined' | 'rejected';

export type AddonValidationFindingCode =
    | 'missing_stream_resource'
    | 'unsupported_types'
    | 'risky_url'
    | 'duplicate_endpoint'
    | 'secret_bearing_url'
    | 'invalid_manifest'
    | 'oversized_response'
    | 'policy_violation'
    | 'http_upstream'
    | 'ok';

export interface AddonValidationFinding {
    code: AddonValidationFindingCode;
    message: string;
    severity: 'info' | 'warning' | 'error';
}

/**
 * A persisted, installed addon record. The `providerId` is the stable id the
 * addon is registered under in the OMSS registry and surfaced in `/v1/providers`
 * (e.g. `addon:torrentio`).
 */
export interface InstalledAddon {
    /** Stable OMSS provider id, e.g. "addon:torrentio". */
    providerId: string;
    /** Short slug derived from the manifest id / host. */
    slug: string;
    /** Display name (from manifest.name). */
    name: string;
    /**
     * Original URL the operator pasted (may include query config). Preserved
     * separately so configuration is never silently dropped.
     */
    originalImportUrl?: string;
    /** Canonical manifest URL (normalized). */
    manifestUrl: string;
    /** Base URL used for resource calls (manifest.json stripped). */
    baseUrl: string;
    /** Whether this addon participates in scraping. */
    enabled: boolean;
    /** Admission / validation state. */
    admissionState?: AddonAdmissionState;
    /** Validation findings from the last import/refresh. */
    validationFindings?: AddonValidationFinding[];
    /** User-controlled ordering (lower = higher priority). */
    order: number;
    /** Per-request soft timeout for the progressive waterfall (ms). */
    timeoutMs: number;
    /** Where this addon was imported from. */
    source: 'url' | 'stremio-account' | 'repository' | 'seed' | 'manual';
    /** The last successfully fetched manifest (cached for id/type/resource logic). */
    manifest: StremioManifest;
    /** ISO timestamps. */
    addedAt: string;
    updatedAt: string;
    /** Last background health-check result (Phase 6 rich telemetry). */
    health?: {
        healthy: boolean;
        lastChecked: string;
        checkType?: 'manifest' | 'stream_probe' | 'subtitle_probe';
        consecutiveSuccesses?: number;
        consecutiveFailures?: number;
        latencyMs?: number;
        failureClassification?: string;
        freshnessWindowMs?: number;
        isFresh?: boolean;
        circuitState?: 'closed' | 'open' | 'half-open';
        error?: string;
    };
    /** Normalized capabilities derived from manifest (cached for fast filtering). */
    capabilities?: AddonCapabilities;
}

export interface AddonStoreData {
    version: 1;
    addons: InstalledAddon[];
    settings?: AppSettings;
    /** Monotonic revision bumped on every mutation (ordering, enable, import…). */
    revision?: number;
}

export function emptyStoreData(): AddonStoreData {
    return { version: 1, addons: [], settings: defaultSettings(), revision: 0 };
}
