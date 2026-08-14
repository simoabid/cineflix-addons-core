/**
 * Durable Job Engine.
 *
 * Implements a concurrency-limited background worker pool that polls the storage backend,
 * acquires jobs using distributed locks / leases, executes registered handlers, renews
 * heartbeats, handles retries with exponential backoff, transitions dead-letter jobs,
 * supports cooperative cancellation via AbortController, and periodically triggers
 * scheduled maintenance cleanups.
 */
import { nanoid } from 'nanoid';
import type { IStorageBackend, JobRecord } from '../storage/types.js';
import type { AddonManager } from '../addons/manager.js';
import type { AppConfig } from '../config.js';
import type {
    JobTypeName,
    JobHandler,
    JobHandlerContext,
    JobEngineOptions,
    EnqueueOptions
} from './types.js';
import { DistributedLockService } from './locks.js';
import {
    multiAddonImportHandler,
    repositoryImportHandler,
    stremioAccountImportHandler
} from './handlers/importHandlers.js';
import {
    manifestRefreshHandler,
    healthSweepHandler,
    maintenanceCleanupHandler
} from './handlers/maintenanceHandlers.js';
import { uncachedTransferHandler } from './handlers/uncachedTransferHandler.js';
import { tracer, logger } from '../telemetry/index.js';
import { globalMetrics } from '../metrics/index.js';

export class JobEngine {
    private readonly handlers = new Map<string, JobHandler>();
    private readonly locks: DistributedLockService;
    private readonly workerId: string;
    private readonly concurrency: number;
    private readonly pollIntervalMs: number;
    private readonly lockDurationMs: number;
    private running = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private outboxTimer: NodeJS.Timeout | null = null;
    private maintenanceTimer: NodeJS.Timeout | null = null;
    private activeWorkerCount = 0;
    private readonly activeJobs = new Map<string, AbortController>();

    constructor(
        public readonly storage: IStorageBackend,
        public readonly manager: AddonManager,
        public readonly cfg: AppConfig,
        opts?: JobEngineOptions
    ) {
        this.workerId = opts?.workerId || `worker_${process.pid}_${nanoid(6)}`;
        this.concurrency = opts?.concurrency || cfg.jobWorkerConcurrency || 4;
        this.pollIntervalMs =
            opts?.pollIntervalMs || cfg.jobPollIntervalMs || 1000;
        this.lockDurationMs = opts?.lockDurationMs || 60_000;
        this.locks = new DistributedLockService(cfg);

        // Register default handlers
        this.registerHandler('multi-addon-import', multiAddonImportHandler);
        this.registerHandler('repository-import', repositoryImportHandler);
        this.registerHandler(
            'stremio-account-import',
            stremioAccountImportHandler
        );
        this.registerHandler('manifest-refresh', manifestRefreshHandler);
        this.registerHandler('health-sweep', healthSweepHandler);
        this.registerHandler('maintenance-cleanup', maintenanceCleanupHandler);
        this.registerHandler('uncached-transfer', uncachedTransferHandler);
    }

    registerHandler(type: string, handler: JobHandler): void {
        this.handlers.set(type, handler);
    }

    hasHandler(type: string): boolean {
        return this.handlers.has(type);
    }

    getRegisteredTypes(): string[] {
        return Array.from(this.handlers.keys());
    }

    async enqueue(
        type: JobTypeName | string,
        payload: Record<string, unknown> = {},
        opts?: EnqueueOptions
    ): Promise<JobRecord> {
        if (!this.hasHandler(type)) {
            throw new Error(
                `Cannot enqueue job with unregistered type '${type}'. Available types: ${this.getRegisteredTypes().join(', ')}`
            );
        }

        // Idempotency check
        if (opts?.idempotencyKey) {
            const existing = await this.storage.getJobByIdempotencyKey(
                opts.idempotencyKey
            );
            if (existing) return existing;
        }

        // Deduplication check
        if (opts?.dedupKey) {
            const active = await this.storage.getJobByDedupKey(
                opts.dedupKey,
                true
            );
            if (active) return active;
        }

        const job = await this.storage.enqueueJob({
            type,
            payload,
            requester: opts?.requester,
            priority: opts?.priority ?? 0,
            maxAttempts: opts?.maxAttempts ?? 3,
            backoffMs: opts?.backoffMs ?? 1000,
            idempotencyKey: opts?.idempotencyKey,
            dedupKey: opts?.dedupKey
        });

        // Trigger immediate polling if worker is idle
        if (this.running && this.activeWorkerCount < this.concurrency) {
            setImmediate(() => void this.pollNext());
        }

        return job;
    }

    async cancel(id: string): Promise<boolean> {
        const controller = this.activeJobs.get(id);
        if (controller) {
            controller.abort(
                Object.assign(new Error('Job cancelled'), {
                    name: 'AbortError',
                    code: 'CANCELLED'
                })
            );
            this.activeJobs.delete(id);
        }
        return this.storage.cancelJob(id);
    }

    async retry(id: string): Promise<JobRecord | null> {
        const job = await this.storage.getJob(id);
        if (!job) return null;
        if (!['failed', 'dead_letter', 'cancelled'].includes(job.status)) {
            return job;
        }
        // Enqueue fresh attempt with same payload
        return this.enqueue(job.type, job.payload, {
            priority: job.priority + 1,
            maxAttempts: job.maxAttempts,
            backoffMs: job.backoffMs,
            requester: job.requester
        });
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        console.log(
            `[jobs] engine started (workerId=${this.workerId}, concurrency=${this.concurrency})`
        );
        this.schedulePoll(100);
        this.scheduleOutboxPoll(500);
        this.scheduleMaintenanceCleanup(10_000);
    }

    stop(): void {
        this.running = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.outboxTimer) {
            clearTimeout(this.outboxTimer);
            this.outboxTimer = null;
        }
        if (this.maintenanceTimer) {
            clearTimeout(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
        // Abort all running jobs
        for (const [id, ctrl] of this.activeJobs.entries()) {
            ctrl.abort();
            this.activeJobs.delete(id);
        }
    }

    private scheduleMaintenanceCleanup(delayMs: number): void {
        if (!this.running) return;
        this.maintenanceTimer = setTimeout(async () => {
            if (!this.running) return;
            try {
                await this.enqueue(
                    'maintenance-cleanup',
                    {},
                    { dedupKey: 'scheduled-maintenance-cleanup' }
                );
            } catch {
                /* ignore */
            }
            this.scheduleMaintenanceCleanup(30 * 60 * 1000); // repeat every 30 minutes
        }, delayMs);
        if (typeof this.maintenanceTimer.unref === 'function') {
            this.maintenanceTimer.unref();
        }
    }

    private schedulePoll(delayMs = this.pollIntervalMs): void {
        if (!this.running) return;
        this.pollTimer = setTimeout(() => {
            void this.pollLoop();
        }, delayMs);
        if (typeof this.pollTimer.unref === 'function') {
            this.pollTimer.unref();
        }
    }

    private async pollLoop(): Promise<void> {
        if (!this.running) return;
        try {
            while (this.running && this.activeWorkerCount < this.concurrency) {
                const acquired = await this.pollNext();
                if (!acquired) break;
            }
        } finally {
            this.schedulePoll(this.pollIntervalMs);
        }
    }

    private async pollNext(): Promise<boolean> {
        if (!this.running || this.activeWorkerCount >= this.concurrency) {
            return false;
        }

        const registeredTypes = Array.from(this.handlers.keys());
        if (registeredTypes.length === 0) return false;

        const job = await this.storage.acquireNextJob(
            this.workerId,
            this.lockDurationMs,
            registeredTypes
        );
        if (!job) return false;

        this.activeWorkerCount++;
        const abortController = new AbortController();
        this.activeJobs.set(job.id, abortController);

        // Execute asynchronously
        void this.executeJob(job, abortController).finally(() => {
            this.activeJobs.delete(job.id);
            this.activeWorkerCount--;
            // If more slots available, poll immediately
            if (this.running && this.activeWorkerCount < this.concurrency) {
                setImmediate(() => void this.pollNext());
            }
        });

        return true;
    }

    private async executeJob(
        job: JobRecord,
        abortController: AbortController
    ): Promise<void> {
        const handler = this.handlers.get(job.type);
        if (!handler) {
            await this.storage.failJob(
                job.id,
                `No handler registered for job type '${job.type}'`,
                this.workerId,
                false
            );
            return;
        }

        const t0 = Date.now();
        await tracer.withSpan(
            'job.execution',
            async (span) => {
                span.setAttribute('job.id', job.id);
                span.setAttribute('job.type', job.type);
                span.setAttribute('worker.id', this.workerId);

                let heartbeatTimer: NodeJS.Timeout | null = null;
                try {
                    // Setup lease renewal heartbeat (every 1/3 of lease duration)
                    const heartbeatIntervalMs = this.lockDurationMs / 3;
                    heartbeatTimer = setInterval(async () => {
                        if (abortController.signal.aborted) return;
                        try {
                            await this.storage.heartbeatJob(
                                job.id,
                                this.workerId,
                                this.lockDurationMs
                            );
                        } catch {
                            /* ignore */
                        }
                    }, heartbeatIntervalMs);
                    if (typeof heartbeatTimer.unref === 'function') {
                        heartbeatTimer.unref();
                    }

                    const ctx: JobHandlerContext = {
                        job,
                        signal: abortController.signal,
                        storage: this.storage,
                        manager: this.manager,
                        cfg: this.cfg,
                        updateProgress: async (progress: number) => {
                            await this.storage.updateJobProgress(
                                job.id,
                                progress,
                                this.workerId
                            );
                        },
                        heartbeat: async () => {
                            return this.storage.heartbeatJob(
                                job.id,
                                this.workerId,
                                this.lockDurationMs
                            );
                        }
                    };

                    const result = await handler(ctx);

                    if (abortController.signal.aborted) {
                        return;
                    }

                    const duration = Date.now() - t0;
                    globalMetrics.recordJobExecution(
                        job.type,
                        'completed',
                        duration
                    );
                    await this.storage.completeJob(
                        job.id,
                        result,
                        this.workerId
                    );

                    logger.info(
                        `Job ${job.id} (${job.type}) completed in ${duration}ms`,
                        {
                            component: 'jobs',
                            jobId: job.id,
                            jobType: job.type,
                            durationMs: duration
                        }
                    );
                } catch (err) {
                    const duration = Date.now() - t0;
                    if (abortController.signal.aborted) {
                        return;
                    }

                    const isAbort =
                        (err as { name?: string })?.name === 'AbortError' ||
                        (err as { code?: string })?.code === 'CANCELLED' ||
                        /cancelled/i.test(
                            err instanceof Error ? err.message : String(err)
                        );

                    if (isAbort) {
                        await this.storage.cancelJob(job.id);
                        return;
                    }

                    globalMetrics.recordJobExecution(
                        job.type,
                        'failed',
                        duration
                    );
                    const errorMsg =
                        err instanceof Error ? err.message : String(err);
                    const canRetry = job.attempts < job.maxAttempts;

                    span.recordException(err as Error);
                    await this.storage.failJob(
                        job.id,
                        errorMsg,
                        this.workerId,
                        canRetry
                    );

                    logger.error(
                        `Job ${job.id} (${job.type}) failed: ${errorMsg}`,
                        {
                            component: 'jobs',
                            jobId: job.id,
                            jobType: job.type,
                            durationMs: duration
                        }
                    );
                } finally {
                    if (heartbeatTimer) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = null;
                    }
                }
            },
            {
                attributes: {
                    'job.id': job.id,
                    'job.type': job.type
                }
            }
        );
    }

    private scheduleOutboxPoll(delayMs = 2000): void {
        if (!this.running) return;
        this.outboxTimer = setTimeout(async () => {
            if (!this.running) return;
            try {
                await this.drainOutbox();
            } catch (err) {
                console.warn(
                    '[jobs:outbox] Error draining outbox:',
                    err instanceof Error ? err.message : err
                );
            } finally {
                this.scheduleOutboxPoll(2000);
            }
        }, delayMs);
        if (typeof this.outboxTimer.unref === 'function') {
            this.outboxTimer.unref();
        }
    }

    private async drainOutbox(): Promise<void> {
        const outboxItems = await this.storage.drainOutbox(20);
        for (const item of outboxItems) {
            try {
                if (this.hasHandler(item.jobType)) {
                    await this.enqueue(item.jobType, item.payload, {
                        priority: 5,
                        idempotencyKey: `outbox_${item.id}`
                    });
                }
                await this.storage.markOutboxProcessed(item.id);
            } catch (err) {
                console.warn(
                    `[jobs:outbox] Failed to enqueue outbox item ${item.id}:`,
                    err instanceof Error ? err.message : err
                );
            }
        }
    }

    getStats(): {
        running: boolean;
        workers: number;
        activeJobs: number;
        registeredTypes: string[];
    } {
        return {
            running: this.running,
            workers: this.concurrency,
            activeJobs: this.activeJobs.size,
            registeredTypes: this.getRegisteredTypes()
        };
    }
}
