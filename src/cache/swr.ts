import { SingleFlightGroup, globalSingleFlight } from './singleFlight.js';

export interface SwrEnvelope<T> {
    value: T;
    cachedAt: number;
    expiresAt: number;
    staleUntil: number;
}

export interface SwrCacheStorage {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSec?: number): Promise<unknown>;
}

export interface SwrOptions {
    ttlSec: number;
    swrSec: number;
    flightGroup?: SingleFlightGroup;
    onRevalidated?: (key: string, freshValue: unknown) => void;
}

export class StaleWhileRevalidate {
    private readonly flight: SingleFlightGroup;

    constructor(flightGroup?: SingleFlightGroup) {
        this.flight = flightGroup || globalSingleFlight;
    }

    /**
     * Executes Stale-While-Revalidate flow:
     * - Returns cached value immediately if still fresh (now <= expiresAt).
     * - Returns stale cached value immediately if in grace period (now <= staleUntil)
     *   and triggers an asynchronous background revalidation via SingleFlight.
     * - Fetches synchronously if not in cache or completely expired.
     */
    async getOrFetch<T>(
        cache: SwrCacheStorage,
        key: string,
        fetcher: () => Promise<T>,
        opts: SwrOptions
    ): Promise<{ value: T; source: 'fresh' | 'stale_swr' | 'miss' }> {
        const raw = await cache.get(key);
        const now = Date.now();

        if (raw) {
            try {
                const env = JSON.parse(raw) as SwrEnvelope<T>;
                if (env && typeof env.cachedAt === 'number') {
                    if (now <= env.expiresAt) {
                        return { value: env.value, source: 'fresh' };
                    }
                    if (now <= env.staleUntil) {
                        // Stale-While-Revalidate: return stale immediately, trigger background refresh
                        void this.revalidateInBackground(cache, key, fetcher, opts);
                        return { value: env.value, source: 'stale_swr' };
                    }
                }
            } catch {
                // corrupted cache item -> treat as miss
            }
        }

        // Miss or completely expired -> synchronous single-flight fetch
        const fresh = await this.flight.do(`swr:${key}`, async () => {
            const result = await fetcher();
            await this.writeEnvelope(cache, key, result, opts);
            return result;
        });

        return { value: fresh, source: 'miss' };
    }

    private async revalidateInBackground<T>(
        cache: SwrCacheStorage,
        key: string,
        fetcher: () => Promise<T>,
        opts: SwrOptions
    ): Promise<void> {
        try {
            await this.flight.do(`swr:${key}`, async () => {
                const fresh = await fetcher();
                await this.writeEnvelope(cache, key, fresh, opts);
                if (opts.onRevalidated) {
                    opts.onRevalidated(key, fresh);
                }
                return fresh;
            });
        } catch (err) {
            console.warn(
                `[swr] background revalidation failed for ${key}:`,
                err instanceof Error ? err.message : err
            );
        }
    }

    private async writeEnvelope<T>(
        cache: SwrCacheStorage,
        key: string,
        value: T,
        opts: SwrOptions
    ): Promise<void> {
        const now = Date.now();
        const totalTtlSec = opts.ttlSec + opts.swrSec;
        const envelope: SwrEnvelope<T> = {
            value,
            cachedAt: now,
            expiresAt: now + opts.ttlSec * 1000,
            staleUntil: now + totalTtlSec * 1000
        };
        await cache.set(key, JSON.stringify(envelope), totalTtlSec);
    }
}

export const globalSwr = new StaleWhileRevalidate();
