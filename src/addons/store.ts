/**
 * Addon persistence. Default: a portable JSON file. Optional: Redis (lazy —
 * only loaded when ADDONS_STORE=redis, so the default build has zero extra deps).
 *
 * The store is intentionally dumb: it reads/writes the entire AddonStoreData
 * blob. The AddonManager owns all mutation logic and calls save() after changes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import {
    type AddonStoreData,
    defaultSettings,
    emptyStoreData
} from './types.js';

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

let saveCounter = 0;

export class FileAddonStore implements AddonStore {
    private readonly file: string;

    constructor(file: string) {
        this.file = path.resolve(file);
    }

    async load(): Promise<AddonStoreData> {
        try {
            const raw = await fs.readFile(this.file, 'utf-8');
            return normalize(JSON.parse(raw));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return emptyStoreData();
            }
            console.warn(
                `[store] Failed to read ${this.file}, starting empty:`,
                err instanceof Error ? err.message : err
            );
            return emptyStoreData();
        }
    }

    async save(data: AddonStoreData): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.${saveCounter++}.tmp`;
        const json = JSON.stringify(data, null, 2);
        await fs.writeFile(tmp, json, 'utf-8');
        await fs.rename(tmp, this.file); // atomic replace
    }

    describe(): string {
        return `file:${this.file}`;
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
            // Indirection keeps this an optional, runtime-only dependency:
            // TypeScript won't try to resolve 'redis' at build time.
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

export function createAddonStore(cfg: AppConfig): AddonStore {
    if (cfg.store === 'redis') return new RedisAddonStore(cfg);
    return new FileAddonStore(cfg.dataFile);
}
