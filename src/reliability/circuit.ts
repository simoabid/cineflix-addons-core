/**
 * Provider reliability — Phase 2.6
 * Circuit breaker, concurrency semaphore, retry, failure classification,
 * negative cache, and metrics are implemented here. This module provides
 * a lightweight single-node implementation suitable for development and
 * small self-hosted deployments. Distributed variants (Redis) can replace it
 * without changing callers.
 */

export type FailureKind =
    | 'timeout'
    | 'dns'
    | 'transport'
    | 'http_4xx'
    | 'http_5xx'
    | 'malformed'
    | 'no_stream'
    | 'no_compatible_id'
    | 'debrid_unavailable'
    | 'unknown';

export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitRecord {
    state: CircuitState;
    failures: number;
    successes: number;
    openedAt?: number;
    lastFailureKind?: FailureKind;
    lastFailureAt?: number;
}

export interface ReliabilityOptions {
    /** Failure threshold to open circuit (default 5). */
    failureThreshold?: number;
    /** Time circuit stays open before half-open trial (ms, default 30s). */
    openTtlMs?: number;
    /** Successes needed to close half-open (default 1). */
    halfOpenSuccessThreshold?: number;
    /** Per-provider concurrency limit (default 2). */
    concurrencyLimit?: number;
    /** Negative-cache TTL for confirmed no-result (ms, default 30s). */
    negativeTtlMs?: number;
}

interface NegativeEntry {
    expiresAt: number;
}

export class ReliabilityRegistry {
    private circuits = new Map<string, CircuitRecord>();
    private semaphores = new Map<string, { count: number; limit: number; queue: Array<{ resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal }> }>();
    private negative = new Map<string, NegativeEntry>();
    private metrics = new Map<
        string,
        { attempts: number; successes: number; failures: number; noResult: number; latencySum: number; lastLatency?: number }
    >();
    private opts: Required<ReliabilityOptions>;
    private hostSemaphores = new Map<string, { count: number; limit: number }>();
    private halfOpenInFlight = new Set<string>();

    constructor(opts: ReliabilityOptions = {}) {
        this.opts = {
            failureThreshold: opts.failureThreshold ?? 5,
            openTtlMs: opts.openTtlMs ?? 30_000,
            halfOpenSuccessThreshold: opts.halfOpenSuccessThreshold ?? 1,
            concurrencyLimit: opts.concurrencyLimit ?? 4,
            negativeTtlMs: opts.negativeTtlMs ?? 30_000
        };
    }

    getState(providerId: string): CircuitState {
        const rec = this.circuits.get(providerId);
        if (!rec) return 'closed';
        if (rec.state === 'open') {
            const elapsed = Date.now() - (rec.openedAt ?? 0);
            if (elapsed > this.opts.openTtlMs) {
                rec.state = 'half-open';
                return 'half-open';
            }
        }
        return rec.state;
    }

    /** Whether this provider may be probed now (single-trial for half-open). */
    isProbeAllowed(providerId: string): boolean {
        const state = this.getState(providerId);
        if (state === 'closed') return true;
        if (state === 'open') return false;
        // half-open: allow only one trial at a time
        if (this.halfOpenInFlight.has(providerId)) return false;
        this.halfOpenInFlight.add(providerId);
        return true;
    }

    private releaseHalfOpen(providerId: string): void {
        this.halfOpenInFlight.delete(providerId);
    }

    recordSuccess(providerId: string, latencyMs: number): void {
        const rec = this.ensureCircuit(providerId);
        rec.successes += 1;
        rec.lastFailureKind = undefined;
        const m = this.ensureMetrics(providerId);
        m.attempts += 1;
        m.successes += 1;
        m.latencySum += latencyMs;
        m.lastLatency = latencyMs;

        if (rec.state === 'half-open' && rec.successes >= this.opts.halfOpenSuccessThreshold) {
            rec.state = 'closed';
            rec.failures = 0;
            rec.successes = 0;
            this.releaseHalfOpen(providerId);
        } else if (rec.state === 'closed') {
            // decay failures on success
            rec.failures = Math.max(0, rec.failures - 1);
        } else if (rec.state === 'half-open') {
            // still need more successes
        }
    }

    recordFailure(providerId: string, kind: FailureKind, latencyMs?: number): void {
        const rec = this.ensureCircuit(providerId);
        rec.failures += 1;
        rec.successes = 0;
        rec.lastFailureKind = kind;
        rec.lastFailureAt = Date.now();
        const m = this.ensureMetrics(providerId);
        m.attempts += 1;
        m.failures += 1;
        if (latencyMs != null) {
            m.latencySum += latencyMs;
            m.lastLatency = latencyMs;
        }
        const wasHalfOpen = rec.state === 'half-open';
        if (kind === 'no_stream' || kind === 'no_compatible_id') {
            // Short negative cache rather than opening circuit for "no result"
            const key = `${providerId}:${kind}`;
            this.negative.set(key, { expiresAt: Date.now() + this.opts.negativeTtlMs });
            m.noResult += 1;
            // However, if we were half-open, a no-result still counts as a failed trial and must reopen
            if (wasHalfOpen) {
                rec.state = 'open';
                rec.openedAt = Date.now();
                this.releaseHalfOpen(providerId);
            }
            return;
        }
        if (rec.failures >= this.opts.failureThreshold && rec.state === 'closed') {
            rec.state = 'open';
            rec.openedAt = Date.now();
        } else if (wasHalfOpen) {
            rec.state = 'open';
            rec.openedAt = Date.now();
            this.releaseHalfOpen(providerId);
        }
    }

    classifyError(err: unknown): FailureKind {
        if (!err || typeof err !== 'object') return 'unknown';
        const errName = (err as Error).name ?? '';
        if (errName === 'TimeoutError' || (err as { code?: string }).code === 'TIMEOUT') return 'timeout';
        const msg = (err as Error).message?.toLowerCase() ?? '';
        if (msg.includes('timed out') || msg.includes('timeout')) return 'timeout';
        if (msg.includes('dns') || msg.includes('enotfound') || msg.includes('eai_again')) return 'dns';
        if (msg.includes('http 4') || (err as { status?: number }).status === 404 || (err as { status?: number }).status === 401) return 'http_4xx';
        if (msg.includes('http 5') || msg.includes('50')) return 'http_5xx';
        if (msg.includes('malformed') || msg.includes('json')) return 'malformed';
        if (msg.includes('debrid')) return 'debrid_unavailable';
        if (msg.includes('no stream') || msg.includes('no compatible')) return 'no_stream';
        return 'transport';
    }

    hasNegative(providerId: string, kind: FailureKind): boolean {
        const key = `${providerId}:${kind}`;
        const entry = this.negative.get(key);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this.negative.delete(key);
            return false;
        }
        return true;
    }

    // ── concurrency semaphore ────────────────────────────────────────────────

    async acquire(providerId: string, host?: string, signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        // Per-provider semaphore
        await this.acquireSemaphore(providerId, this.opts.concurrencyLimit, signal);
        let hostRelease: (() => void) | null = null;
        if (host) {
            try {
                await this.acquireSemaphore(`host:${host}`, this.opts.concurrencyLimit * 2, signal);
                hostRelease = () => this.releaseSemaphore(`host:${host}`);
            } catch (err) {
                this.releaseSemaphore(providerId);
                throw err;
            }
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.releaseSemaphore(providerId);
            if (hostRelease) hostRelease();
        };
    }

    private acquireSemaphore(key: string, limit: number, signal?: AbortSignal): Promise<void> {
        let sem = this.semaphores.get(key);
        if (!sem) {
            sem = { count: 0, limit, queue: [] };
            this.semaphores.set(key, sem);
        } else {
            sem.limit = limit;
        }
        if (sem.count < sem.limit) {
            sem.count += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const entry = {
                resolve: () => {
                    sem!.count += 1;
                    resolve();
                },
                reject,
                signal
            };
            sem!.queue.push(entry);
            if (signal) {
                const onAbort = () => {
                    const idx = sem!.queue.indexOf(entry);
                    if (idx !== -1) sem!.queue.splice(idx, 1);
                    signal.removeEventListener('abort', onAbort);
                    reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    private releaseSemaphore(key: string): void {
        const sem = this.semaphores.get(key);
        if (!sem) return;
        sem.count = Math.max(0, sem.count - 1);
        const next = sem.queue.shift();
        if (next) {
            // Clean up abort listener if present
            if (next.signal) {
                // listener already once, but ensure removed by not needed
            }
            next.resolve();
        }
    }

    // ── retry helper ────────────────────────────────────────────────────────

    /**
     * Retry idempotent transient failures with jittered exponential backoff.
     * Only retries on retryable kinds (timeout, transport, http_5xx).
     */
    isRetryable(kind: FailureKind): boolean {
        return kind === 'timeout' || kind === 'transport' || kind === 'http_5xx' || kind === 'dns';
    }

    async withRetry<T>(
        fn: () => Promise<T>,
        opts: { maxAttempts?: number; baseMs?: number; signal?: AbortSignal } = {}
    ): Promise<T> {
        const maxAttempts = opts.maxAttempts ?? 3;
        const baseMs = opts.baseMs ?? 200;
        const signal = opts.signal;
        if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        let lastErr: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (signal?.aborted) throw err;
                const kind = this.classifyError(err);
                if (attempt === maxAttempts - 1 || !this.isRetryable(kind)) throw err;
                const backoff = baseMs * Math.pow(2, attempt) + Math.random() * 100;
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, backoff);
                    if (signal) {
                        const onAbort = () => {
                            clearTimeout(timer);
                            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                        };
                        if (signal.aborted) onAbort();
                        else signal.addEventListener('abort', onAbort, { once: true });
                    }
                });
            }
        }
        throw lastErr;
    }

    // ── metrics ─────────────────────────────────────────────────────────────

    getMetrics(providerId: string): { attempts: number; successes: number; failures: number; noResult: number; avgLatency?: number } {
        const m = this.metrics.get(providerId);
        if (!m) return { attempts: 0, successes: 0, failures: 0, noResult: 0 };
        return {
            attempts: m.attempts,
            successes: m.successes,
            failures: m.failures,
            noResult: m.noResult,
            avgLatency: m.attempts ? Math.round(m.latencySum / m.attempts) : undefined
        };
    }

    snapshot(): Record<string, { state: CircuitState; metrics: ReturnType<ReliabilityRegistry['getMetrics']> }> {
        const out: Record<string, { state: CircuitState; metrics: ReturnType<ReliabilityRegistry['getMetrics']> }> = {};
        for (const [id] of this.metrics) {
            out[id] = { state: this.getState(id), metrics: this.getMetrics(id) };
        }
        for (const [id, rec] of this.circuits) {
            if (!out[id]) out[id] = { state: rec.state, metrics: this.getMetrics(id) };
        }
        return out;
    }

    private ensureCircuit(providerId: string): CircuitRecord {
        let rec = this.circuits.get(providerId);
        if (!rec) {
            rec = { state: 'closed', failures: 0, successes: 0 };
            this.circuits.set(providerId, rec);
        }
        return rec;
    }

    private ensureMetrics(providerId: string): { attempts: number; successes: number; failures: number; noResult: number; latencySum: number; lastLatency?: number } {
        let m = this.metrics.get(providerId);
        if (!m) {
            m = { attempts: 0, successes: 0, failures: 0, noResult: 0, latencySum: 0 };
            this.metrics.set(providerId, m);
        }
        return m;
    }
}

export const globalReliability = new ReliabilityRegistry();
