import type { StremioManifest } from '../stremio/protocol.js';
import type { DebridProviderId } from '../debrid/types.js';
import type { AddonCapabilities } from '../capabilities/index.js';
import type {
    AddonAdmissionState,
    AddonValidationFinding
} from '../addons/types.js';

export interface AddonRecord {
    /** Stable OMSS provider id, e.g. "addon:torrentio". */
    providerId: string;
    slug: string;
    name: string;
    originalImportUrl?: string;
    manifestUrl: string;
    baseUrl: string;
    enabled: boolean;
    admissionState?: AddonAdmissionState;
    validationFindings?: AddonValidationFinding[];
    order: number;
    timeoutMs: number;
    source: 'url' | 'stremio-account' | 'repository' | 'seed' | 'manual';
    manifest: StremioManifest;
    capabilities?: AddonCapabilities;
    version: number;
    addedAt: string;
    updatedAt: string;
    health?: {
        healthy: boolean;
        lastChecked: string;
        error?: string;
    };
}

export interface AddonRevisionRecord {
    id: string;
    revision: number;
    mutatedBy?: string;
    action: string;
    createdAt: string;
}

export interface AddonHealthRecord {
    providerId: string;
    healthy: boolean;
    error?: string;
    checkedAt: string;
}

export interface DebridConfigRecord {
    id: string;
    provider: DebridProviderId;
    apiKeyCiphertext?: string;
    updatedAt: string;
}

export interface PlaybackGrantRecord {
    id: string;
    url: string;
    headersJson: string;
    providerId?: string;
    mediaKey?: string;
    expiresAt: number;
    createdAt: number;
    maxRedirects: number;
    singleUse: boolean;
    used: boolean;
    addonRevision?: number;
}

export interface AuditEventRecord {
    id: string;
    actorJson: string;
    action: string;
    target?: string;
    requestId?: string;
    revision?: number;
    outcome: 'success' | 'failure' | 'denied';
    beforeJson?: string;
    afterJson?: string;
    reason?: string;
    metaJson?: string;
    timestamp: string;
}

export type JobStatus =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'dead_letter';

export interface JobRecord {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    requester?: {
        id?: string;
        ip?: string;
        role?: string;
    };
    status: JobStatus;
    priority: number;
    attempts: number;
    maxAttempts: number;
    backoffMs: number;
    progress: number;
    result?: unknown;
    error?: string;
    idempotencyKey?: string;
    dedupKey?: string;
    lockedBy?: string;
    lockedUntil?: number;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
}

export interface OutboxRecord {
    id: string;
    jobType: string;
    payload: Record<string, unknown>;
    status: 'pending' | 'processed' | 'failed';
    createdAt: number;
    processedAt?: number;
}

export interface EnqueueJobInput {
    id?: string;
    type: string;
    payload?: Record<string, unknown>;
    requester?: {
        id?: string;
        ip?: string;
        role?: string;
    };
    priority?: number;
    maxAttempts?: number;
    backoffMs?: number;
    idempotencyKey?: string;
    dedupKey?: string;
}

export interface ListJobsFilter {
    type?: string;
    status?: JobStatus;
    limit?: number;
    offset?: number;
}

export interface SanitizedExportData {
    version: number;
    revision: number;
    addons: Array<{
        providerId: string;
        slug: string;
        name: string;
        enabled: boolean;
        admissionState?: AddonAdmissionState;
        validationFindings?: AddonValidationFinding[];
        order: number;
        timeoutMs: number;
        source: string;
        manifest: StremioManifest;
        capabilities?: AddonCapabilities;
        addedAt: string;
        updatedAt: string;
    }>;
    exportedAt: string;
}

export class OptimisticLockError extends Error {
    constructor(
        public readonly entity: string,
        public readonly id: string,
        public readonly expectedVersion: number,
        public readonly actualVersion: number
    ) {
        super(
            `Optimistic lock conflict on ${entity} '${id}': expected version ${expectedVersion}, found ${actualVersion}`
        );
        this.name = 'OptimisticLockError';
    }
}

export interface IStorageBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    describe(): string;

    // Revision
    getRevision(): Promise<number>;
    bumpRevision(action: string, actor?: string): Promise<number>;

    // Addons
    listAddons(): Promise<AddonRecord[]>;
    getAddon(providerId: string): Promise<AddonRecord | null>;
    saveAddon(
        addon: AddonRecord,
        expectedVersion?: number,
        outboxJob?: { type: string; payload: Record<string, unknown> }
    ): Promise<AddonRecord>;
    removeAddon(
        providerId: string,
        outboxJob?: { type: string; payload: Record<string, unknown> }
    ): Promise<boolean>;
    reorderAddons(order: string[]): Promise<void>;

    // Debrid
    getDebridConfig(): Promise<DebridConfigRecord | null>;
    saveDebridConfig(config: DebridConfigRecord): Promise<void>;

    // Health
    recordHealth(health: AddonHealthRecord): Promise<void>;
    getHealth(providerId: string): Promise<AddonHealthRecord | null>;
    listHealth(): Promise<AddonHealthRecord[]>;

    // Grants
    saveGrant(grant: PlaybackGrantRecord): Promise<void>;
    getGrant(id: string): Promise<PlaybackGrantRecord | null>;
    consumeGrant(id: string): Promise<PlaybackGrantRecord | null>;
    revokeGrant(id: string): Promise<boolean>;
    cleanupExpiredGrants(now?: number): Promise<number>;

    // Audit
    recordAudit(event: AuditEventRecord): Promise<void>;
    listAudit(limit?: number): Promise<AuditEventRecord[]>;

    // Jobs
    enqueueJob(input: EnqueueJobInput): Promise<JobRecord>;
    getJob(id: string): Promise<JobRecord | null>;
    getJobByIdempotencyKey(key: string): Promise<JobRecord | null>;
    getJobByDedupKey(
        key: string,
        activeOnly?: boolean
    ): Promise<JobRecord | null>;
    listJobs(filter?: ListJobsFilter): Promise<JobRecord[]>;
    acquireNextJob(
        workerId: string,
        lockDurationMs: number,
        types?: string[]
    ): Promise<JobRecord | null>;
    updateJobProgress(
        id: string,
        progress: number,
        workerId: string
    ): Promise<void>;
    heartbeatJob(
        id: string,
        workerId: string,
        lockDurationMs: number
    ): Promise<boolean>;
    completeJob(id: string, result: unknown, workerId: string): Promise<void>;
    failJob(
        id: string,
        error: string,
        workerId: string,
        retryable?: boolean
    ): Promise<JobRecord>;
    cancelJob(id: string): Promise<boolean>;
    cleanupJobs(maxAgeMs: number): Promise<number>;

    // Outbox
    drainOutbox(batchSize?: number): Promise<OutboxRecord[]>;
    markOutboxProcessed(id: string): Promise<void>;

    // Export
    exportSanitized(): Promise<SanitizedExportData>;
}
