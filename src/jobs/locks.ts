import { nanoid } from 'nanoid';
import type { AppConfig } from '../config.js';

export interface LockHandle {
    resource: string;
    token: string;
    expiresAt: number;
}

export class DistributedLockService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private redisClient: any = null;
    private readonly memoryLocks = new Map<
        string,
        { token: string; expiresAt: number }
    >();

    constructor(private readonly cfg: AppConfig) {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async getRedis(): Promise<any> {
        if (this.redisClient) return this.redisClient;
        if (this.cfg.cacheType !== 'redis') return null;
        try {
            const moduleName = 'redis';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mod = (await import(moduleName)) as any;
            const auth = this.cfg.redis.password
                ? `:${encodeURIComponent(this.cfg.redis.password)}@`
                : '';
            const url = `redis://${auth}${this.cfg.redis.host}:${this.cfg.redis.port}`;
            const client = mod.createClient({ url });
            client.on('error', () => {});
            await client.connect();
            this.redisClient = client;
            return this.redisClient;
        } catch {
            return null;
        }
    }

    /**
     * Attempts to acquire a lock on `resource` for `ttlMs`.
     * Returns a LockHandle if acquired, or null if already held.
     */
    async acquire(
        resource: string,
        ttlMs = 15000,
        token = nanoid()
    ): Promise<LockHandle | null> {
        const lockKey = `lock:v1:${resource}`;
        const redis = await this.getRedis();

        if (redis) {
            try {
                // Redis SET NX PX
                const res = await redis.set(lockKey, token, {
                    NX: true,
                    PX: ttlMs
                });
                if (res === 'OK') {
                    return {
                        resource,
                        token,
                        expiresAt: Date.now() + ttlMs
                    };
                }
                return null;
            } catch {
                /* fall back to memory */
            }
        }

        // Memory lease lock
        const now = Date.now();
        const existing = this.memoryLocks.get(lockKey);
        if (existing && existing.expiresAt > now) {
            return null;
        }

        const handle: LockHandle = {
            resource,
            token,
            expiresAt: now + ttlMs
        };
        this.memoryLocks.set(lockKey, { token, expiresAt: handle.expiresAt });
        return handle;
    }

    /**
     * Releases a previously acquired lock safely (verifies token).
     */
    async release(handle: LockHandle): Promise<boolean> {
        const lockKey = `lock:v1:${handle.resource}`;
        const redis = await this.getRedis();

        if (redis) {
            try {
                // Safe unlock via Lua
                const lua = `
                    if redis.call("get", KEYS[1]) == ARGV[1] then
                        return redis.call("del", KEYS[1])
                    else
                        return 0
                    end
                `;
                const res = await redis.eval(lua, {
                    keys: [lockKey],
                    arguments: [handle.token]
                });
                return res === 1;
            } catch {
                /* fall back */
            }
        }

        const existing = this.memoryLocks.get(lockKey);
        if (existing && existing.token === handle.token) {
            this.memoryLocks.delete(lockKey);
            return true;
        }
        return false;
    }

    /**
     * Extends a currently held lock.
     */
    async extend(handle: LockHandle, ttlMs = 15000): Promise<boolean> {
        const lockKey = `lock:v1:${handle.resource}`;
        const redis = await this.getRedis();

        if (redis) {
            try {
                const lua = `
                    if redis.call("get", KEYS[1]) == ARGV[1] then
                        return redis.call("pexpire", KEYS[1], ARGV[2])
                    else
                        return 0
                    end
                `;
                const res = await redis.eval(lua, {
                    keys: [lockKey],
                    arguments: [handle.token, String(ttlMs)]
                });
                if (res === 1) {
                    handle.expiresAt = Date.now() + ttlMs;
                    return true;
                }
                return false;
            } catch {
                /* fall back */
            }
        }

        const existing = this.memoryLocks.get(lockKey);
        if (existing && existing.token === handle.token) {
            existing.expiresAt = Date.now() + ttlMs;
            handle.expiresAt = existing.expiresAt;
            return true;
        }
        return false;
    }

    /**
     * Executes `fn` within an exclusive distributed lock.
     */
    async withLock<T>(
        resource: string,
        ttlMs: number,
        fn: (handle: LockHandle) => Promise<T>
    ): Promise<T> {
        const handle = await this.acquire(resource, ttlMs);
        if (!handle) {
            throw new Error(`Could not acquire lock for resource: ${resource}`);
        }
        try {
            return await fn(handle);
        } finally {
            await this.release(handle);
        }
    }
}
