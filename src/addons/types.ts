import type { StremioManifest } from '../stremio/protocol.js';
import type { DebridProviderId } from '../debrid/types.js';

export interface AppSettings {
    debrid: {
        provider: DebridProviderId;
        apiKey: string;
    };
}

export function defaultSettings(): AppSettings {
    return { debrid: { provider: 'none', apiKey: '' } };
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
    /** Canonical manifest URL. */
    manifestUrl: string;
    /** Base URL used for resource calls (manifest.json stripped). */
    baseUrl: string;
    /** Whether this addon participates in scraping. */
    enabled: boolean;
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
    /** Last background health-check result. */
    health?: {
        healthy: boolean;
        lastChecked: string;
        error?: string;
    };
}

export interface AddonStoreData {
    version: 1;
    addons: InstalledAddon[];
    settings?: AppSettings;
}

export function emptyStoreData(): AddonStoreData {
    return { version: 1, addons: [], settings: defaultSettings() };
}
