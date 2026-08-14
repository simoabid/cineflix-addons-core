/**
 * Addon persistence. Default: a portable JSON file. Optional: Postgres (transactional),
 * Redis (lazy).
 */
import type { AppConfig } from '../config.js';
import {
    type AddonStoreData,
    defaultSettings,
    emptyStoreData,
    type InstalledAddon
} from './types.js';
import type {
    IStorageBackend,
    AddonRecord
} from '../storage/types.js';
import { PostgresStorageBackend } from '../storage/postgres/index.js';
import { FileStorageBackend } from '../storage/file/index.js';

export interface AddonStore {
    load(): Promise<AddonStoreData>;
    save(data: AddonStoreData): Promise<void>;
    describe(): string;
}

function normalize(data: unknown): AddonStoreData {
    if (
        data &&
        typeof data === 'object' &&
        Array.isArray((data as AddonStoreData).addons)
    ) {
        const d = data as AddonStoreData;
        return {
            version: 1,
            addons: d.addons,
            settings: d.settings ?? defaultSettings(),
            revision: typeof d.revision === 'number' ? d.revision : 0
        };
    }
    return emptyStoreData();
}

export class BackendAddonStore implements AddonStore {
    constructor(private readonly backend: IStorageBackend) {}

    async load(): Promise<AddonStoreData> {
        await this.backend.init();
        const addons = await this.backend.listAddons();
        const revision = await this.backend.getRevision();
        const debrid = await this.backend.getDebridConfig();

        return {
            version: 1,
            revision,
            addons: addons as InstalledAddon[],
            settings: debrid
                ? {
                      debrid: {
                          provider: debrid.provider,
                          apiKey: debrid.apiKeyCiphertext || ''
                      }
                  }
                : defaultSettings()
        };
    }

    async save(data: AddonStoreData): Promise<void> {
        // Reconcile deleted addons
        const existing = await this.backend.listAddons();
        const currentIds = new Set(data.addons.map((a) => a.providerId));
        for (const prev of existing) {
            if (!currentIds.has(prev.providerId)) {
                await this.backend.removeAddon(prev.providerId);
            }
        }
        for (const a of data.addons) {
            await this.backend.saveAddon(a as AddonRecord);
        }
        if (data.settings?.debrid) {
            await this.backend.saveDebridConfig({
                id: 'default',
                provider: data.settings.debrid.provider,
                apiKeyCiphertext: data.settings.debrid.apiKey,
                updatedAt: new Date().toISOString()
            });
        }
    }

    describe(): string {
        return this.backend.describe();
    }
}

/**
 * Redis-backed store. Uses node-redis (`redis`) which is imported lazily and
 * only required when ADDONS_STORE=redis. Install it yourself in that case:
 *   npm i redis
 */
export class RedisAddonStore implements AddonStore {
    private client: unknown;
    private readonly key = 'addons-core:store';
    private readonly url: string;

    constructor(cfg: AppConfig) {
        const auth = cfg.redis.password
            ? `:${encodeURIComponent(cfg.redis.password)}@`
            : '';
        this.url = `redis://${auth}${cfg.redis.host}:${cfg.redis.port}`;
    }

    private async getClient(): Promise<{
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string) => Promise<unknown>;
    }> {
        if (this.client) {
            return this.client as never;
        }
        let mod: { createClient: (opts: { url: string }) => unknown };
        try {
            const moduleName = 'redis';
            mod = (await import(moduleName)) as {
                createClient: (opts: { url: string }) => unknown;
            };
        } catch {
            throw new Error(
                "ADDONS_STORE=redis requires the 'redis' package. Run: npm i redis"
            );
        }
        const client = mod.createClient({ url: this.url }) as {
            connect: () => Promise<void>;
            on: (ev: string, cb: (e: unknown) => void) => void;
        };
        client.on('error', (e) =>
            console.error('[store:redis] client error:', e)
        );
        await client.connect();
        this.client = client;
        return client as never;
    }

    async load(): Promise<AddonStoreData> {
        const client = await this.getClient();
        const raw = await client.get(this.key);
        if (!raw) return emptyStoreData();
        try {
            return normalize(JSON.parse(raw));
        } catch {
            return emptyStoreData();
        }
    }

    async save(data: AddonStoreData): Promise<void> {
        const client = await this.getClient();
        await client.set(this.key, JSON.stringify(data));
    }

    describe(): string {
        return `redis:${this.url.replace(/:[^:@]*@/, ':***@')}`;
    }
}

export function createAddonStore(
    cfg: AppConfig,
    backend?: IStorageBackend
): AddonStore {
    if (backend) return new BackendAddonStore(backend);
    if (cfg.store === 'postgres') {
        return new BackendAddonStore(new PostgresStorageBackend(cfg));
    }
    if (cfg.store === 'redis') return new RedisAddonStore(cfg);
    return new BackendAddonStore(new FileStorageBackend(cfg.dataFile));
}
