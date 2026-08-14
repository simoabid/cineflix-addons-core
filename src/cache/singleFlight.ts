/**
 * SingleFlight — coalesces duplicate concurrent in-flight asynchronous operations.
 *
 * Prevents "thundering herd" or cache stampede problems when multiple incoming requests
 * ask for the exact same uncached media or provider stream at the same moment.
 */

interface InFlightEntry<T> {
    promise: Promise<T>;
    subscribers: number;
    startedAt: number;
}

export class SingleFlightGroup {
    private readonly inFlight = new Map<string, InFlightEntry<unknown>>();
    private totalCoalesced = 0;
    private totalExecuted = 0;

    /**
     * Executes `fn` unless a call with `key` is already running, in which case
     * it joins the existing Promise.
     */
    async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const existing = this.inFlight.get(key) as InFlightEntry<T> | undefined;
        if (existing) {
            this.totalCoalesced++;
            existing.subscribers++;
            return existing.promise;
        }

        this.totalExecuted++;
        const entry: InFlightEntry<T> = {
            promise: (async () => {
                try {
                    return await fn();
                } finally {
                    this.inFlight.delete(key);
                }
            })(),
            subscribers: 1,
            startedAt: Date.now()
        };

        this.inFlight.set(key, entry as InFlightEntry<unknown>);
        return entry.promise;
    }

    /** Number of currently active, in-flight coalesced executions. */
    inFlightCount(): number {
        return this.inFlight.size;
    }

    /** Snapshot metrics. */
    metrics(): {
        activeInFlight: number;
        totalExecuted: number;
        totalCoalesced: number;
    } {
        return {
            activeInFlight: this.inFlight.size,
            totalExecuted: this.totalExecuted,
            totalCoalesced: this.totalCoalesced
        };
    }

    /** Clear any pending in-flight keys. */
    reset(): void {
        this.inFlight.clear();
        this.totalCoalesced = 0;
        this.totalExecuted = 0;
    }
}

export const globalSingleFlight = new SingleFlightGroup();
