/**
 * ConcurrencyCoordinator (Phase 7 §10.1).
 *
 * Owns one bounded pool per class of remote work so classes cannot starve
 * each other: a burst of bulk scrapes can saturate the bulk pool, but health
 * checks, admin refreshes, and proxy streaming keep their own reserved
 * capacity. Pools are created from AppConfig; a module-level singleton
 * (`globalConcurrency`) is configured by server.ts at boot, mirroring the
 * `globalReliability` pattern used across the codebase.
 *
 * Pools:
 *   bulk-scrape        whole aggregate lookups (weight = providers fanned out)
 *   progressive-scrape single-provider waterfall requests
 *   provider-stream    per-provider stream resource calls
 *   outbound-host      per-hostname outbound HTTP (via scrapeFetch choke point)
 *   subtitles          subtitle aggregation lookups
 *   manifest           manifest import / refresh fetches
 *   health             background health probes
 *   debrid             debrid API calls
 *   proxy-stream       proxied playback streams (full media bodies)
 *   hls-segment        HLS/DASH segment fetches through the proxy
 */

import type { AppConfig } from '../config.js';
import {
    WeightedSemaphore,
    type SemaphoreStats,
    type AcquireOptions
} from './semaphore.js';

export type PoolName =
    | 'bulk-scrape'
    | 'progressive-scrape'
    | 'provider-stream'
    | 'outbound-host'
    | 'subtitles'
    | 'manifest'
    | 'health'
    | 'debrid'
    | 'proxy-stream'
    | 'hls-segment';

const POOL_LIMIT_KEYS: Record<
    Exclude<PoolName, 'outbound-host'>,
    keyof AppConfig['concurrency']
> = {
    'bulk-scrape': 'bulkScrape',
    'progressive-scrape': 'progressiveScrape',
    'provider-stream': 'providerStream',
    subtitles: 'subtitles',
    manifest: 'manifest',
    health: 'health',
    debrid: 'debrid',
    'proxy-stream': 'proxyStream',
    'hls-segment': 'hlsSegment'
};

/** Per-host pools are created on demand; prune idle ones beyond this count. */
const MAX_TRACKED_HOSTS = 256;

export class ConcurrencyCoordinator {
    private readonly pools = new Map<PoolName | string, WeightedSemaphore>();
    private readonly hostAccess = new Map<string, number>();
    private queueMax: number;
    private queueTimeoutMs: number;
    private perHostLimit: number;
    private configured = false;

    constructor(cfg?: AppConfig) {
        this.queueMax = cfg?.concurrency.queueMax ?? 200;
        this.queueTimeoutMs = cfg?.concurrency.queueTimeoutMs ?? 5000;
        this.perHostLimit = Math.max(1, cfg?.concurrency.outboundHost ?? 8);
        if (cfg) this.configure(cfg);
    }

    /** (Re)create named pools from config. Host pools use perHostLimit. */
    configure(cfg: AppConfig): void {
        this.configured = true;
        this.queueMax = Math.max(0, Math.floor(cfg.concurrency.queueMax));
        this.queueTimeoutMs = Math.max(0, cfg.concurrency.queueTimeoutMs);
        for (const [pool, key] of Object.entries(POOL_LIMIT_KEYS) as Array<
            [Exclude<PoolName, 'outbound-host'>, keyof AppConfig['concurrency']]
        >) {
            this.pools.set(
                pool,
                new WeightedSemaphore({
                    name: pool,
                    limit: Math.max(1, cfg.concurrency[key]),
                    maxQueue: this.queueMax,
                    queueTimeoutMs: this.queueTimeoutMs
                })
            );
        }
        // Drop cached host pools so they re-create with the fresh limit.
        this.perHostLimit = Math.max(1, cfg.concurrency.outboundHost);
        for (const key of [...this.pools.keys()]) {
            if (key.startsWith('host:')) {
                this.pools.delete(key);
                this.hostAccess.delete(key);
            }
        }
    }

    /** Named pool accessor (created from config; throws if unconfigured). */
    pool(name: PoolName): WeightedSemaphore {
        const existing = this.pools.get(name);
        if (existing) return existing;
        const limitKey =
            POOL_LIMIT_KEYS[name as Exclude<PoolName, 'outbound-host'>];
        const limit = limitKey ? this.limitFromDefaults(name) : 4;
        const sem = new WeightedSemaphore({
            name,
            limit,
            maxQueue: this.queueMax,
            queueTimeoutMs: this.queueTimeoutMs
        });
        this.pools.set(name, sem);
        return sem;
    }

    private limitFromDefaults(name: PoolName): number {
        // Fallback defaults when the coordinator was constructed without cfg
        // (tests) and configure() has not run yet.
        const defaults: Record<string, number> = {
            'bulk-scrape': 8,
            'progressive-scrape': 16,
            'provider-stream': 4,
            subtitles: 8,
            manifest: 6,
            health: 4,
            debrid: 6,
            'proxy-stream': 32,
            'hls-segment': 64
        };
        return defaults[name] ?? 4;
    }

    /** Lazily-created per-hostname pool (outbound-host class). */
    hostPool(hostname: string): WeightedSemaphore {
        const key = `host:${hostname.toLowerCase()}`;
        const existing = this.pools.get(key);
        if (existing) {
            this.hostAccess.set(key, Date.now());
            return existing;
        }
        if (this.hostAccess.size >= MAX_TRACKED_HOSTS) {
            this.pruneIdleHostPools();
        }
        const sem = new WeightedSemaphore({
            name: key,
            limit: this.perHostLimit,
            maxQueue: this.queueMax,
            queueTimeoutMs: this.queueTimeoutMs
        });
        this.pools.set(key, sem);
        this.hostAccess.set(key, Date.now());
        return sem;
    }

    private pruneIdleHostPools(): void {
        const entries = [...this.hostAccess.entries()].sort(
            (a, b) => a[1] - b[1]
        );
        for (const [key] of entries.slice(
            0,
            Math.floor(MAX_TRACKED_HOSTS / 2)
        )) {
            const sem = this.pools.get(key);
            const stats = sem?.stats();
            if (sem && stats && stats.inFlight === 0 && stats.queued === 0) {
                this.pools.delete(key);
                this.hostAccess.delete(key);
            }
        }
    }

    /** Convenience: run fn inside a named pool slot. */
    async withSlot<T>(
        name: PoolName,
        fn: () => Promise<T>,
        opts: AcquireOptions = {}
    ): Promise<T> {
        return this.pool(name).withSlot(fn, opts);
    }

    /** Convenience: run fn inside a per-host pool slot. */
    async withHostSlot<T>(
        hostname: string,
        fn: () => Promise<T>,
        opts: AcquireOptions = {}
    ): Promise<T> {
        return this.hostPool(hostname).withSlot(fn, opts);
    }

    /** Shutdown: abort all queued waiters across every pool. */
    abortAllQueued(): number {
        let n = 0;
        for (const sem of this.pools.values()) {
            n += sem.abortQueued();
        }
        return n;
    }

    snapshot(): Record<string, SemaphoreStats> {
        const out: Record<string, SemaphoreStats> = {};
        for (const [name, sem] of this.pools) {
            out[name] = sem.stats();
        }
        return out;
    }

    get isConfigured(): boolean {
        return this.configured;
    }
}

/**
 * Process-wide coordinator. server.ts configures it from loadConfig() at
 * boot; tests may configure it directly. Before configuration, pools use
 * safe defaults.
 */
export const globalConcurrency = new ConcurrencyCoordinator();
