/**
 * Stream concurrency controls (Phase 7 §10.4).
 *
 * Caps concurrent proxied playback streams per client IP, per
 * authenticated user/service account, and globally (per deployment when
 * Redis is configured — grants already require Redis in production, so the
 * same connection is reused; single-instance deployments fall back to
 * in-memory counters).
 *
 * Counters use INCR with a safety TTL so an instance crash cannot leak a
 * slot forever; releases DECR symmetrically.
 */

import { logger } from '../telemetry/logger.js';

export type StreamLimitReason = 'per_ip' | 'per_user' | 'global';

export class StreamConcurrencyError extends Error {
    readonly code = 'STREAM_LIMIT_EXCEEDED';
    readonly reason: StreamLimitReason;
    readonly limit: number;
    constructor(reason: StreamLimitReason, limit: number, scope: string) {
        super(
            `Concurrent stream limit reached (${reason.replace('_', ' ')} limit ${limit} for ${scope})`
        );
        this.name = 'StreamConcurrencyError';
        this.reason = reason;
        this.limit = limit;
    }
}

export interface StreamIdentity {
    ip: string;
    /** Authenticated actor id when available (service account or admin user). */
    userId?: string;
    /** Diagnostics only — which grant started the stream. */
    grantId?: string;
}

export interface StreamConcurrencyOptions {
    maxPerIp: number;
    maxPerUser: number;
    maxGlobal: number;
    /** Redis config; when absent, in-memory counters are used. */
    redis?: { host: string; port: number; password?: string };
    /** Counter safety TTL (default 10 min). */
    ttlMs?: number;
}

const KEY_PREFIX = 'streamcount:v1';
const TTL_MS = 10 * 60 * 1000;

interface MemoryCounter {
    count: number;
    expiresAt: number;
}

/** Minimal Redis surface used by the shared counters. */
interface RedisCounterClient {
    incr(key: string): Promise<number>;
    decr(key: string): Promise<number>;
    get(key: string): Promise<string | null>;
    expire(key: string, seconds: number): Promise<unknown>;
    del(key: string): Promise<number>;
    on(event: string, cb: (e: unknown) => void): unknown;
    connect(): Promise<void>;
}

export class StreamConcurrencyTracker {
    private readonly opts: Required<
        Pick<StreamConcurrencyOptions, 'maxPerIp' | 'maxPerUser' | 'maxGlobal'>
    > &
        StreamConcurrencyOptions;
    private redisClient: RedisCounterClient | null = null;
    private redisInitAttempted = false;
    private readonly memory = new Map<string, MemoryCounter>();
    private activeIp = 0;
    private activeUser = 0;
    private activeGlobal = 0;

    constructor(opts: StreamConcurrencyOptions) {
        this.opts = {
            ...opts,
            maxPerIp: Math.max(0, Math.floor(opts.maxPerIp)),
            maxPerUser: Math.max(0, Math.floor(opts.maxPerUser)),
            maxGlobal: Math.max(0, Math.floor(opts.maxGlobal))
        };
        if (opts.redis) void this.getRedis();
    }

    private async getRedis(): Promise<RedisCounterClient | null> {
        if (this.redisClient) return this.redisClient;
        if (this.redisInitAttempted || !this.opts.redis) return null;
        this.redisInitAttempted = true;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mod = (await import('redis')) as any;
            const cfg = this.opts.redis;
            const auth = cfg.password
                ? `:${encodeURIComponent(cfg.password)}@`
                : '';
            const url = `redis://${auth}${cfg.host}:${cfg.port}`;
            const client = mod.createClient({ url });
            client.on('error', (e: unknown) =>
                logger.debug('stream-counter redis error', {
                    component: 'capacity',
                    error: e instanceof Error ? e.message : String(e)
                })
            );
            await client.connect();
            this.redisClient = client as RedisCounterClient;
            return this.redisClient;
        } catch {
            // Expected in dev/tests without Redis — memory fallback applies.
            return null;
        }
    }

    private keys(identity: StreamIdentity): {
        ipKey: string;
        userKey?: string;
        globalKey: string;
    } {
        return {
            ipKey: `${KEY_PREFIX}:ip:${identity.ip}`,
            userKey: identity.userId
                ? `${KEY_PREFIX}:user:${identity.userId}`
                : undefined,
            globalKey: `${KEY_PREFIX}:global`
        };
    }

    /**
     * Reserve one concurrent-stream slot for the identity. Resolves with an
     * idempotent release function. Rejects with StreamConcurrencyError when
     * any applicable cap is already reached.
     */
    async acquire(identity: StreamIdentity): Promise<() => Promise<void>> {
        const { ipKey, userKey, globalKey } = this.keys(identity);
        const redis = await this.getRedis();
        const ttlSec = Math.ceil((this.opts.ttlMs ?? TTL_MS) / 1000);

        const acquiredKeys: string[] = [];
        try {
            // Reserve in strictest-first order: global → user → ip, rolling
            // back on the first rejection so caps never leak on failure.
            if (this.opts.maxGlobal > 0) {
                await this.reserve(redis, globalKey, ttlSec, acquiredKeys);
                if (
                    await this.overLimit(redis, globalKey, this.opts.maxGlobal)
                ) {
                    throw new StreamConcurrencyError(
                        'global',
                        this.opts.maxGlobal,
                        'deployment'
                    );
                }
            }
            if (userKey && this.opts.maxPerUser > 0) {
                await this.reserve(redis, userKey, ttlSec, acquiredKeys);
                if (
                    await this.overLimit(redis, userKey, this.opts.maxPerUser)
                ) {
                    throw new StreamConcurrencyError(
                        'per_user',
                        this.opts.maxPerUser,
                        identity.userId ?? 'unknown'
                    );
                }
            }
            if (this.opts.maxPerIp > 0) {
                await this.reserve(redis, ipKey, ttlSec, acquiredKeys);
                if (await this.overLimit(redis, ipKey, this.opts.maxPerIp)) {
                    throw new StreamConcurrencyError(
                        'per_ip',
                        this.opts.maxPerIp,
                        identity.ip
                    );
                }
            }
        } catch (err) {
            await this.rollback(redis, acquiredKeys);
            throw err;
        }

        // Memory gauges (per-instance view for /metrics).
        this.activeGlobal++;
        this.activeIp++;
        if (identity.userId) this.activeUser++;

        let released = false;
        return async () => {
            if (released) return;
            released = true;
            this.activeGlobal = Math.max(0, this.activeGlobal - 1);
            this.activeIp = Math.max(0, this.activeIp - 1);
            if (identity.userId) {
                this.activeUser = Math.max(0, this.activeUser - 1);
            }
            const keys = [ipKey, globalKey];
            if (userKey) keys.push(userKey);
            await this.decrement(redis, keys);
        };
    }

    private async reserve(
        redis: RedisCounterClient | null,
        key: string,
        ttlSec: number,
        acquiredKeys: string[]
    ): Promise<void> {
        if (redis) {
            await redis.incr(key);
            await redis.expire(key, ttlSec);
            acquiredKeys.push(key);
            return;
        }
        const now = Date.now();
        const rec = this.memory.get(key);
        if (!rec || rec.expiresAt < now) {
            this.memory.set(key, { count: 1, expiresAt: now + ttlSec * 1000 });
        } else {
            rec.count += 1;
        }
        acquiredKeys.push(key);
    }

    private async overLimit(
        redis: RedisCounterClient | null,
        key: string,
        limit: number
    ): Promise<boolean> {
        if (redis) {
            const n = Number(await redis.get(key));
            return Number.isFinite(n) && n > limit;
        }
        const rec = this.memory.get(key);
        if (!rec) return false;
        // Expired counters must not count toward the limit (TTL reclaims but
        // the entry may still be in memory until next purge).
        if (rec.expiresAt < Date.now()) return false;
        return rec.count > limit;
    }

    private async rollback(
        redis: RedisCounterClient | null,
        keys: string[]
    ): Promise<void> {
        await this.decrement(redis, keys);
    }

    private async decrement(
        redis: RedisCounterClient | null,
        keys: string[]
    ): Promise<void> {
        for (const key of keys) {
            try {
                if (redis) {
                    const n = Number(await redis.decr(key));
                    if (n <= 0) await redis.del(key);
                } else {
                    const rec = this.memory.get(key);
                    if (rec) {
                        rec.count -= 1;
                        if (rec.count <= 0) this.memory.delete(key);
                    }
                }
            } catch {
                /* best-effort: TTL eventually reclaims */
            }
        }
    }

    /** Drop expired memory counters (maintenance). */
    purgeExpired(): number {
        const now = Date.now();
        let n = 0;
        for (const [key, rec] of this.memory) {
            if (rec.expiresAt < now) {
                this.memory.delete(key);
                n++;
            }
        }
        return n;
    }

    /** Per-instance gauges for metrics/diagnostics. */
    gauge(): { activeStreams: number; activeIps: number; activeUsers: number } {
        return {
            activeStreams: this.activeGlobal,
            activeIps: this.activeIp,
            activeUsers: this.activeUser
        };
    }

    /** Whether counters are shared across instances. */
    get mode(): 'redis' | 'memory' {
        return this.redisClient ? 'redis' : 'memory';
    }
}
