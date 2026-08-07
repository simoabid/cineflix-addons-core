/**
 * Lightweight in-process rate limiter for destructive / high-cost actions.
 *
 * Keyed by actor id + IP + route bucket. Suitable for single-instance
 * deployments (phase 1). Multi-instance will move this to Redis later.
 */

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSec: number;
    limit: number;
}

interface Bucket {
    count: number;
    resetAt: number;
}

export interface RateLimiter {
    /** Check and consume one unit. */
    take(key: string, limit: number, windowMs: number): RateLimitResult;
    /** Reset a key (tests). */
    reset(key?: string): void;
}

export function createRateLimiter(): RateLimiter {
    const buckets = new Map<string, Bucket>();

    // Opportunistic cleanup
    let ops = 0;

    function cleanup(now: number): void {
        if (++ops % 64 !== 0) return;
        for (const [k, b] of buckets) {
            if (b.resetAt <= now) buckets.delete(k);
        }
    }

    return {
        take(key: string, limit: number, windowMs: number): RateLimitResult {
            const now = Date.now();
            cleanup(now);
            let b = buckets.get(key);
            if (!b || b.resetAt <= now) {
                b = { count: 0, resetAt: now + windowMs };
                buckets.set(key, b);
            }
            if (b.count >= limit) {
                return {
                    allowed: false,
                    remaining: 0,
                    retryAfterSec: Math.max(
                        1,
                        Math.ceil((b.resetAt - now) / 1000)
                    ),
                    limit
                };
            }
            b.count += 1;
            return {
                allowed: true,
                remaining: Math.max(0, limit - b.count),
                retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
                limit
            };
        },
        reset(key?: string): void {
            if (key) buckets.delete(key);
            else buckets.clear();
        }
    };
}

/** Standard buckets used by management routes. */
export const RATE_LIMITS = {
    /** Import URL / repository / stremio account. */
    import: { limit: 20, windowMs: 60_000 },
    /** Destructive remove. */
    remove: { limit: 30, windowMs: 60_000 },
    /** Debrid settings + credential check. */
    debrid: { limit: 10, windowMs: 60_000 },
    /** Health sweep. */
    health: { limit: 6, windowMs: 60_000 },
    /** Auth/login attempts. */
    auth: { limit: 20, windowMs: 60_000 },
    /** Generic mutation. */
    mutate: { limit: 60, windowMs: 60_000 },
    /** Refresh is high-cost scraping. */
    refresh: { limit: 10, windowMs: 60_000 },
    /** Secure proxy grants redemption (per IP). */
    proxy: { limit: 120, windowMs: 60_000 }
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export function rateLimitKey(
    bucket: string,
    actorId: string | undefined,
    ip: string | undefined
): string {
    return `${bucket}:${actorId ?? 'anon'}:${ip ?? 'unknown'}`;
}
