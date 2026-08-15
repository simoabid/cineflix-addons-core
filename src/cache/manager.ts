import type { AppConfig } from '../config.js';
import { globalMetrics } from '../metrics/index.js';
import {
    buildMediaKey,
    buildProviderResultKey,
    buildAggregateResultKey,
    buildPlaybackGrantKey,
    buildHealthKey,
    buildCircuitKey,
    DEFAULT_CACHE_TTLS,
    type CacheTtlConfig
} from './namespaces.js';
import { SingleFlightGroup, globalSingleFlight } from './singleFlight.js';
import { StaleWhileRevalidate, type SwrCacheStorage } from './swr.js';

export interface CacheMetrics {
    hits: number;
    misses: number;
    swrHits: number;
    sets: number;
    evictions: number;
    bypasses: number;
    cardinality: number;
    backend: 'redis' | 'memory';
}

interface MemoryCacheEntry {
    value: string;
    expiresAt: number;
}

export class MemoryLruCache implements SwrCacheStorage {
    private readonly map = new Map<string, MemoryCacheEntry>();
    public evictions = 0;

    constructor(private readonly maxEntries = 10_000) {}

    async get(key: string): Promise<string | null> {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.map.delete(key);
            return null;
        }
        // Move to most recently used (re-insert)
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    async set(key: string, value: string, ttlSec = 3600): Promise<void> {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.maxEntries) {
            // Evict oldest (first key in map iterator)
            const oldest = this.map.keys().next().value as string | undefined;
            if (oldest) {
                this.map.delete(oldest);
                this.evictions++;
            }
        }
        this.map.set(key, {
            value,
            expiresAt: Date.now() + ttlSec * 1000
        });
    }

    async del(key: string): Promise<boolean> {
        return this.map.delete(key);
    }

    async deletePrefix(prefix: string): Promise<number> {
        let count = 0;
        for (const k of [...this.map.keys()]) {
            if (k.startsWith(prefix)) {
                this.map.delete(k);
                count++;
            }
        }
        return count;
    }

    async clear(): Promise<void> {
        this.map.clear();
    }

    size(): number {
        return this.map.size;
    }
}

export class CacheManager {
    private readonly memory = new MemoryLruCache(10_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private redisClient: any = null;
    private readonly backendType: 'redis' | 'memory';
    public readonly flight: SingleFlightGroup;
    public readonly swr: StaleWhileRevalidate;
    public readonly ttls: CacheTtlConfig;

    private hits = 0;
    private misses = 0;
    private swrHits = 0;
    private sets = 0;
    private bypasses = 0;

    constructor(
        private readonly cfg: AppConfig,
        ttls?: Partial<CacheTtlConfig>,
        flightGroup?: SingleFlightGroup
    ) {
        this.backendType = cfg.cacheType === 'redis' ? 'redis' : 'memory';
        this.ttls = { ...DEFAULT_CACHE_TTLS, ...ttls };
        this.flight = flightGroup || globalSingleFlight;
        this.swr = new StaleWhileRevalidate(this.flight);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async getRedis(): Promise<any> {
        if (this.redisClient) return this.redisClient;
        try {
            const moduleName = 'redis';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mod = (await import(moduleName)) as any;
            const auth = this.cfg.redis.password
                ? `:${encodeURIComponent(this.cfg.redis.password)}@`
                : '';
            const url = `redis://${auth}${this.cfg.redis.host}:${this.cfg.redis.port}`;
            const client = mod.createClient({ url });
            client.on('error', (e: unknown) =>
                console.error('[cache:redis] client error:', e)
            );
            await client.connect();
            this.redisClient = client;
            return this.redisClient;
        } catch (err) {
            console.warn(
                '[cache] Redis failed to initialize, falling back to memory LRU cache:',
                err instanceof Error ? err.message : err
            );
            return null;
        }
    }

    async get<T>(key: string): Promise<T | null> {
        const t0 = Date.now();
        try {
            let raw: string | null = null;
            if (this.backendType === 'redis') {
                const redis = await this.getRedis();
                if (redis) {
                    raw = await redis.get(key);
                }
            }
            if (!raw) {
                raw = await this.memory.get(key);
            }

            globalMetrics.recordStorageOperation(
                'cache_get',
                'ok',
                Date.now() - t0
            );

            if (raw) {
                this.hits++;
                try {
                    return JSON.parse(raw) as T;
                } catch {
                    return raw as unknown as T;
                }
            }
            this.misses++;
            return null;
        } catch (err) {
            globalMetrics.recordStorageOperation(
                'cache_get',
                'error',
                Date.now() - t0
            );
            throw err;
        }
    }

    async set<T>(key: string, value: T, ttlSec = 3600): Promise<void> {
        const t0 = Date.now();
        this.sets++;
        try {
            const raw =
                typeof value === 'string' ? value : JSON.stringify(value);
            if (this.backendType === 'redis') {
                const redis = await this.getRedis();
                if (redis) {
                    await redis.set(key, raw, { EX: ttlSec });
                }
            }
            await this.memory.set(key, raw, ttlSec);
            globalMetrics.recordStorageOperation(
                'cache_set',
                'ok',
                Date.now() - t0
            );
        } catch (err) {
            globalMetrics.recordStorageOperation(
                'cache_set',
                'error',
                Date.now() - t0
            );
            throw err;
        }
    }

    async del(key: string): Promise<void> {
        const t0 = Date.now();
        try {
            if (this.backendType === 'redis') {
                const redis = await this.getRedis();
                if (redis) {
                    await redis.del(key);
                }
            }
            await this.memory.del(key);
            globalMetrics.recordStorageOperation(
                'cache_del',
                'ok',
                Date.now() - t0
            );
        } catch (err) {
            globalMetrics.recordStorageOperation(
                'cache_del',
                'error',
                Date.now() - t0
            );
            throw err;
        }
    }

    /** Invalidate all keys matching a prefix using non-blocking SCAN iterator. */
    async invalidatePrefix(prefix: string): Promise<number> {
        let count = 0;
        if (this.backendType === 'redis') {
            const redis = await this.getRedis();
            if (redis) {
                try {
                    if (typeof redis.scanIterator === 'function') {
                        const batch: string[] = [];
                        for await (const key of redis.scanIterator({
                            MATCH: `${prefix}*`,
                            COUNT: 100
                        })) {
                            batch.push(key as string);
                            if (batch.length >= 100) {
                                count += await redis.del(batch);
                                batch.length = 0;
                            }
                        }
                        if (batch.length > 0) {
                            count += await redis.del(batch);
                        }
                    } else if (typeof redis.scan === 'function') {
                        let cursor = '0';
                        do {
                            const reply = await redis.scan(
                                cursor,
                                'MATCH',
                                `${prefix}*`,
                                'COUNT',
                                100
                            );
                            cursor = reply[0];
                            const keys = reply[1];
                            if (keys && keys.length > 0) {
                                count += await redis.del(keys);
                            }
                        } while (cursor !== '0');
                    }
                } catch {
                    /* ignore */
                }
            }
        }
        count += await this.memory.deletePrefix(prefix);
        return count;
    }

    /** Event-driven invalidation when provider revision changes. */
    async invalidateOnRevisionChange(newRevision: number): Promise<void> {
        await this.invalidatePrefix('aggregate-result:v1:');
        await this.invalidatePrefix('provider-result:v1:');
        console.log(
            `[cache] invalidated aggregate and provider caches for revision ${newRevision}`
        );
    }

    /** Event-driven invalidation when debrid settings change. */
    async invalidateOnDebridChange(): Promise<void> {
        await this.invalidatePrefix('aggregate-result:v1:');
        await this.invalidatePrefix('provider-result:v1:');
        console.log(
            '[cache] invalidated provider/aggregate caches on debrid change'
        );
    }

    /** Event-driven invalidation when a provider becomes quarantined/unhealthy. */
    async invalidateOnHealthChange(providerId: string): Promise<void> {
        await this.del(buildHealthKey(providerId));
        await this.del(buildCircuitKey(providerId));
        await this.invalidatePrefix('aggregate-result:v1:');
    }

    /** Clear all caches. */
    async clear(): Promise<void> {
        if (this.backendType === 'redis') {
            const redis = await this.getRedis();
            if (redis) {
                try {
                    await redis.flushDb();
                } catch {
                    /* ignore */
                }
            }
        }
        await this.memory.clear();
        this.flight.reset();
    }

    /**
     * Phase 7 §10.2 — close the Redis connection cleanly at shutdown so the
     * event loop can exit within the grace period. Safe to call when only the
     * in-memory backend is active.
     */
    async close(): Promise<void> {
        if (this.redisClient) {
            try {
                await this.redisClient.quit();
            } catch {
                /* best-effort: destroy if quit hangs/fails */
                try {
                    void this.redisClient.destroy?.();
                } catch {
                    /* ignore */
                }
            }
            this.redisClient = null;
        }
    }

    /** Check if request specifies privileged cache bypass. */
    shouldBypass(
        auth:
            | { role?: string; isOperator?: boolean; isAdmin?: boolean }
            | undefined,
        headers: Record<string, string | string[] | undefined>
    ): boolean {
        const bypassHeader =
            headers['x-cache-bypass'] ||
            headers['X-Cache-Bypass'] ||
            headers['cache-control'] === 'no-cache';

        if (!bypassHeader) return false;
        const isBypassVal =
            bypassHeader === 'true' ||
            bypassHeader === '1' ||
            bypassHeader === 'no-cache';

        if (!isBypassVal) return false;

        // Verify privileged caller (operator or admin or dev mode)
        const isPrivileged =
            this.cfg.authMode === 'disabled' ||
            auth?.role === 'admin' ||
            auth?.role === 'operator' ||
            auth?.isAdmin ||
            auth?.isOperator;

        if (isPrivileged) {
            this.bypasses++;
            return true;
        }
        return false;
    }

    /** Wrap SwrCacheStorage interface for SWR wrapper. */
    asSwrStorage(): SwrCacheStorage {
        return {
            get: async (k: string) => {
                if (this.backendType === 'redis') {
                    const redis = await this.getRedis();
                    if (redis) {
                        const r = await redis.get(k);
                        if (r) return r;
                    }
                }
                return this.memory.get(k);
            },
            set: async (k: string, v: string, ttl?: number) => {
                await this.set(k, v, ttl);
            }
        };
    }

    snapshot(): CacheMetrics {
        return {
            hits: this.hits,
            misses: this.misses,
            swrHits: this.swrHits,
            sets: this.sets,
            evictions: this.memory.evictions,
            bypasses: this.bypasses,
            cardinality: this.memory.size(),
            backend: this.backendType
        };
    }
}

export {
    buildMediaKey,
    buildProviderResultKey,
    buildAggregateResultKey,
    buildPlaybackGrantKey,
    buildHealthKey,
    buildCircuitKey
};
