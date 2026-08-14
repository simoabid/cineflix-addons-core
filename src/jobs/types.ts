import type { JobRecord, IStorageBackend } from '../storage/types.js';
import type { AddonManager } from '../addons/manager.js';
import type { AppConfig } from '../config.js';

export type JobTypeName =
    | 'multi-addon-import'
    | 'repository-import'
    | 'stremio-account-import'
    | 'manifest-refresh'
    | 'health-sweep'
    | 'maintenance-cleanup'
    | 'uncached-transfer';

export interface JobHandlerContext {
    job: JobRecord;
    signal: AbortSignal;
    updateProgress: (progress: number) => Promise<void>;
    heartbeat: () => Promise<boolean>;
    manager: AddonManager;
    storage: IStorageBackend;
    cfg: AppConfig;
    traceId?: string;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<unknown>;

export interface EnqueueOptions {
    priority?: number;
    maxAttempts?: number;
    backoffMs?: number;
    idempotencyKey?: string;
    dedupKey?: string;
    requester?: {
        id?: string;
        ip?: string;
        role?: string;
    };
}

export interface JobEngineOptions {
    workerId?: string;
    concurrency?: number;
    pollIntervalMs?: number;
    lockDurationMs?: number;
    outboxPollIntervalMs?: number;
}
