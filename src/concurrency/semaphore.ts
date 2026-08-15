/**
 * Weighted, priority-aware semaphore (Phase 7 §10.1).
 *
 * One semaphore manages a pool of capacity measured in abstract *weight*
 * units rather than plain slots. Acquisitions declare how much capacity
 * they need; larger requests (e.g. a bulk scrape fanning out to many
 * providers) consume proportionally more. Waiting acquisitions are
 * admitted in (priority desc, arrival order) so operational work such as
 * health checks or admin-triggered refreshes can jump ahead of user
 * traffic without starving it.
 *
 * Every acquisition is abortable, bounded by a queue timeout, and the
 * queue itself has a hard depth cap so saturation fails fast instead of
 * unbounded piling up.
 */

export class SemaphoreFullError extends Error {
    readonly code = 'SEMAPHORE_FULL';
    readonly pool: string;
    constructor(pool: string, maxQueue: number) {
        super(
            `Concurrency pool '${pool}' queue is full (${maxQueue} waiting) — rejecting to fail fast`
        );
        this.name = 'SemaphoreFullError';
        this.pool = pool;
    }
}

export class SemaphoreTimeoutError extends Error {
    readonly code = 'QUEUE_TIMEOUT';
    readonly pool: string;
    readonly waitedMs: number;
    constructor(pool: string, waitedMs: number) {
        super(
            `Timed out after ${waitedMs}ms waiting for concurrency pool '${pool}'`
        );
        this.name = 'SemaphoreTimeoutError';
        this.pool = pool;
        this.waitedMs = waitedMs;
    }
}

export function isAborted(signal: AbortSignal | undefined): boolean {
    return Boolean(signal?.aborted);
}

export function abortError(): Error {
    return Object.assign(
        new Error('Aborted while waiting for concurrency slot'),
        {
            name: 'AbortError'
        }
    );
}

export interface SemaphoreOptions {
    /** Pool name (diagnostics / errors). */
    name: string;
    /** Total weight capacity admitted concurrently. */
    limit: number;
    /** Max waiting acquisitions; beyond this, acquire() rejects. */
    maxQueue?: number;
    /** Default ms a queued acquisition may wait before rejecting. */
    queueTimeoutMs?: number;
}

export interface AcquireOptions {
    /** Capacity units required (default 1). Must be <= limit. */
    weight?: number;
    /** Higher priority admissions are dequeued first (default 0). */
    priority?: number;
    /** Cooperative cancellation. */
    signal?: AbortSignal;
    /** Override the pool's default queue timeout for this acquisition. */
    queueTimeoutMs?: number;
}

export interface SemaphoreStats {
    name: string;
    limit: number;
    inFlight: number;
    queued: number;
    maxQueue: number;
    totalAdmitted: number;
    totalRejectedFull: number;
    totalQueueTimeouts: number;
    totalAborted: number;
}

interface QueueEntry {
    weight: number;
    priority: number;
    seq: number;
    enqueuedAt: number;
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    timer?: ReturnType<typeof setTimeout>;
}

export class WeightedSemaphore {
    readonly name: string;
    readonly limit: number;
    readonly maxQueue: number;
    private readonly queueTimeoutMs: number;

    private inFlight = 0;
    private seq = 0;
    private queue: QueueEntry[] = [];

    private totalAdmitted = 0;
    private totalRejectedFull = 0;
    private totalQueueTimeouts = 0;
    private totalAborted = 0;

    constructor(opts: SemaphoreOptions) {
        this.name = opts.name;
        this.limit = Math.max(1, Math.floor(opts.limit));
        this.maxQueue = Math.max(
            0,
            Math.floor(opts.maxQueue ?? this.limit * 8)
        );
        this.queueTimeoutMs = Math.max(0, opts.queueTimeoutMs ?? 10_000);
    }

    /**
     * Acquire `weight` units of capacity. Resolves with a release function
     * (idempotent). Rejects with SemaphoreFullError / SemaphoreTimeoutError /
     * AbortError.
     */
    async acquire(opts: AcquireOptions = {}): Promise<() => void> {
        const weight = Math.min(
            this.limit,
            Math.max(1, Math.floor(opts.weight ?? 1))
        );
        const priority = opts.priority ?? 0;

        if (opts.signal?.aborted) throw abortError();

        // Fast path: capacity available and nobody queued ahead.
        if (this.inFlight + weight <= this.limit && this.queue.length === 0) {
            this.inFlight += weight;
            this.totalAdmitted++;
            return this.makeReleaser(weight);
        }

        if (this.queue.length >= this.maxQueue) {
            this.totalRejectedFull++;
            throw new SemaphoreFullError(this.name, this.maxQueue);
        }

        return new Promise<() => void>((resolve, reject) => {
            const entry: QueueEntry = {
                weight,
                priority,
                seq: this.seq++,
                enqueuedAt: Date.now(),
                resolve: () => {
                    this.inFlight += weight;
                    this.totalAdmitted++;
                    resolve(this.makeReleaser(weight));
                },
                reject
            };

            const timeoutMs =
                opts.queueTimeoutMs != null
                    ? opts.queueTimeoutMs
                    : this.queueTimeoutMs;
            if (timeoutMs > 0) {
                // Ref'd (not unref'd): the rejection must fire even when no
                // other work keeps the event loop alive, otherwise a queued
                // caller could hang forever. The hold is bounded by
                // queueTimeoutMs and cleared on admission/abort/release.
                entry.timer = setTimeout(() => {
                    this.removeQueued(entry);
                    this.totalQueueTimeouts++;
                    reject(
                        new SemaphoreTimeoutError(
                            this.name,
                            Date.now() - entry.enqueuedAt
                        )
                    );
                }, timeoutMs);
            }

            if (opts.signal) {
                entry.signal = opts.signal;
                entry.onAbort = () => {
                    this.removeQueued(entry);
                    this.totalAborted++;
                    reject(abortError());
                };
                opts.signal.addEventListener('abort', entry.onAbort, {
                    once: true
                });
            }

            // Insert in (priority desc, seq asc) order — stable FIFO within a priority.
            let idx = this.queue.length;
            while (idx > 0 && this.queue[idx - 1].priority < entry.priority) {
                idx--;
            }
            this.queue.splice(idx, 0, entry);
        });
    }

    /** Run `fn` while holding `weight` units; always releases. */
    async withSlot<T>(
        fn: () => Promise<T>,
        opts: AcquireOptions = {}
    ): Promise<T> {
        const release = await this.acquire(opts);
        try {
            return await fn();
        } finally {
            release();
        }
    }

    /** Build an idempotent release function for an admitted acquisition. */
    private makeReleaser(weight: number): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.inFlight -= weight;
            this.pump();
        };
    }

    private removeQueued(entry: QueueEntry): void {
        const idx = this.queue.indexOf(entry);
        if (idx === -1) return;
        this.queue.splice(idx, 1);
        this.cleanupEntry(entry);
    }

    private cleanupEntry(entry: QueueEntry): void {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal && entry.onAbort) {
            entry.signal.removeEventListener('abort', entry.onAbort);
        }
    }

    /** Admit queued entries while capacity allows (priority first). */
    private pump(): void {
        while (this.queue.length > 0) {
            const next = this.queue[0];
            if (this.inFlight + next.weight > this.limit) {
                // Head doesn't fit — only bypass it with entries of the *same*
                // priority tier. This avoids a stream of small low-priority
                // requests indefinitely starving a large high-priority head
                // (see Phase 7 §10.1 priority queue doc), while still allowing
                // same-priority head-of-line blocking to be relieved so a
                // weight-2 + weight-2 held pool can admit a queued weight-1
                // behind a weight-3 head of equal priority.
                const headPriority = next.priority;
                const idx = this.queue.findIndex(
                    (e) =>
                        e.priority === headPriority &&
                        this.inFlight + e.weight <= this.limit
                );
                if (idx === -1) return;
                const fitting = this.queue[idx];
                this.queue.splice(idx, 1);
                this.cleanupEntry(fitting);
                fitting.resolve();
                continue;
            }
            this.queue.shift();
            this.cleanupEntry(next);
            next.resolve();
        }
    }

    /**
     * Abort every queued waiter (shutdown path). In-flight work is NOT
     * cancelled — draining is the caller's policy.
     */
    abortQueued(): number {
        const n = this.queue.length;
        for (const entry of this.queue.splice(0)) {
            this.cleanupEntry(entry);
            this.totalAborted++;
            entry.reject(abortError());
        }
        return n;
    }

    stats(): SemaphoreStats {
        return {
            name: this.name,
            limit: this.limit,
            inFlight: this.inFlight,
            queued: this.queue.length,
            maxQueue: this.maxQueue,
            totalAdmitted: this.totalAdmitted,
            totalRejectedFull: this.totalRejectedFull,
            totalQueueTimeouts: this.totalQueueTimeouts,
            totalAborted: this.totalAborted
        };
    }
}
