/**
 * Graceful shutdown & rolling-deploy support (Phase 7 §10.2).
 *
 * ReadinessGate — process-wide flag that flips the moment shutdown begins so
 * `/health/ready` answers 503 and the load balancer drains this replica
 * while remaining requests finish.
 *
 * ShutdownCoordinator — runs registered close phases in deterministic order
 * (stop accepting work → drain jobs/HTTP → close listeners → close
 * dependencies) each under its own timeout, bounded by an overall grace
 * period, then exits. A second signal force-exits immediately so an
 * orchestrator's kill always wins.
 */

import { logger } from '../telemetry/logger.js';

export type ShutdownState = 'running' | 'shutting_down' | 'completed';

export class ReadinessGate {
    private shutdownAt: number | null = null;
    private shutdownReason: string | null = null;

    beginShutdown(reason = 'unspecified'): void {
        if (this.shutdownAt == null) {
            this.shutdownAt = Date.now();
            this.shutdownReason = reason;
        }
    }

    get isShuttingDown(): boolean {
        return this.shutdownAt != null;
    }

    get startedAt(): number | null {
        return this.shutdownAt;
    }

    get reason(): string | null {
        return this.shutdownReason;
    }

    /** Milliseconds since shutdown began (0 before). */
    get elapsedMs(): number {
        return this.shutdownAt == null ? 0 : Date.now() - this.shutdownAt;
    }
}

/** Process-wide gate shared by health routes and the shutdown coordinator. */
export const globalReadinessGate = new ReadinessGate();

export interface ShutdownPhase {
    name: string;
    run: () => Promise<void>;
    /** Per-phase cap; defaults to the remaining grace period. */
    timeoutMs?: number;
}

export interface PhaseResult {
    name: string;
    ok: boolean;
    durationMs: number;
    error?: string;
}

export interface ShutdownOptions {
    /** Overall wall-clock budget for the whole shutdown sequence. */
    gracePeriodMs: number;
    /** Exit code on completed shutdown (default 0). */
    exitCode?: number;
    /** Install SIGTERM/SIGINT handlers (default true). Second signal force-exits. */
    installSignals?: boolean;
}

export class ShutdownCoordinator {
    private readonly phases: ShutdownPhase[] = [];
    private state: ShutdownState = 'running';
    private results: PhaseResult[] = [];
    private signalCount = 0;
    private readonly gracePeriodMs: number;
    private readonly exitCode: number;
    private readonly installSignals: boolean;

    constructor(
        private readonly gate: ReadinessGate,
        opts: ShutdownOptions
    ) {
        this.gracePeriodMs = Math.max(500, opts.gracePeriodMs);
        this.exitCode = opts.exitCode ?? 0;
        this.installSignals = opts.installSignals ?? true;
        if (this.installSignals) {
            process.once('SIGTERM', () => this.onSignal('SIGTERM'));
            process.once('SIGINT', () => this.onSignal('SIGINT'));
        }
    }

    /** Register a phase; phases run in registration order. */
    addPhase(name: string, run: () => Promise<void>, timeoutMs?: number): this {
        this.phases.push({ name, run, timeoutMs });
        return this;
    }

    private onSignal(signal: string): void {
        this.signalCount++;
        if (this.signalCount > 1) {
            logger.error(`Second ${signal} received — forcing immediate exit`, {
                component: 'lifecycle'
            });
            process.exit(130);
        }
        void this.begin(signal);
    }

    /** Test/programmatic entry point (same as receiving a signal). */
    async begin(reason: string): Promise<void> {
        if (this.state !== 'running') return;
        this.state = 'shutting_down';

        const startedAt = Date.now();
        this.gate.beginShutdown(reason);
        logger.info(
            `Shutdown beginning (reason=${reason}, gracePeriodMs=${this.gracePeriodMs})`,
            {
                component: 'lifecycle',
                reason,
                gracePeriodMs: this.gracePeriodMs
            }
        );

        for (const phase of this.phases) {
            const remaining = this.gracePeriodMs - (Date.now() - startedAt);
            if (remaining <= 0) {
                this.results.push({
                    name: phase.name,
                    ok: false,
                    durationMs: 0,
                    error: 'skipped: grace period exhausted'
                });
                continue;
            }
            const cap = Math.min(phase.timeoutMs ?? remaining, remaining);
            const t0 = Date.now();
            try {
                await withTimeout(phase.run(), cap, phase.name);
                this.results.push({
                    name: phase.name,
                    ok: true,
                    durationMs: Date.now() - t0
                });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : String(err);
                logger.error(
                    `Shutdown phase '${phase.name}' failed: ${message}`,
                    {
                        component: 'lifecycle',
                        phase: phase.name
                    }
                );
                this.results.push({
                    name: phase.name,
                    ok: false,
                    durationMs: Date.now() - t0,
                    error: message
                });
            }
        }

        this.state = 'completed';
        const totalMs = Date.now() - startedAt;
        logger.info(
            `Shutdown complete in ${totalMs}ms (${this.results.filter((r) => r.ok).length}/${this.results.length} phases ok)`,
            { component: 'lifecycle', totalMs, results: this.results }
        );

        if (this.installSignals) {
            process.exit(this.exitCode);
        }
    }

    get currentState(): ShutdownState {
        return this.state;
    }

    get phaseResults(): PhaseResult[] {
        return [...this.results];
    }
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new Error(`phase '${label}' timed out after ${timeoutMs}ms`)
                ),
            timeoutMs
        );
        if (typeof timer.unref === 'function') timer.unref();
        promise.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            }
        );
    });
}
