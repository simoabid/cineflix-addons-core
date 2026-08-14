import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { globalMetrics } from '../../metrics/index.js';
import {
    type IStorageBackend,
    type AddonRecord,
    type AddonRevisionRecord,
    type AddonHealthRecord,
    type DebridConfigRecord,
    type PlaybackGrantRecord,
    type AuditEventRecord,
    type JobRecord,
    type OutboxRecord,
    type EnqueueJobInput,
    type ListJobsFilter,
    type SanitizedExportData,
    OptimisticLockError
} from '../types.js';

interface FileStoreData {
    version: 1;
    revision: number;
    addons: AddonRecord[];
    revisions: AddonRevisionRecord[];
    health: Record<string, AddonHealthRecord>;
    debrid?: DebridConfigRecord;
    grants: Record<string, PlaybackGrantRecord>;
    audit: AuditEventRecord[];
    jobs: Record<string, JobRecord>;
    outbox: OutboxRecord[];
}

let fileCounter = 0;

export class FileStorageBackend implements IStorageBackend {
    private readonly file: string;
    private data: FileStoreData = {
        version: 1,
        revision: 0,
        addons: [],
        revisions: [],
        health: {},
        grants: {},
        audit: [],
        jobs: {},
        outbox: []
    };
    private lock: Promise<unknown> = Promise.resolve();

    constructor(file: string) {
        this.file = path.resolve(file);
    }

    private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.lock.then(fn, fn);
        this.lock = next.then(
            () => {},
            () => {}
        );
        return next;
    }

    async init(): Promise<void> {
        await this.load();
    }

    async close(): Promise<void> {
        // flush
        await this.persist();
    }

    describe(): string {
        return `file:${this.file}`;
    }

    private async load(): Promise<void> {
        const t0 = Date.now();
        try {
            const raw = await fs.readFile(this.file, 'utf-8');
            const parsed = JSON.parse(raw);
            this.data = {
                version: 1,
                revision:
                    typeof parsed.revision === 'number' ? parsed.revision : 0,
                addons: Array.isArray(parsed.addons)
                    ? parsed.addons.map((a: AddonRecord) => ({
                          ...a,
                          version: a.version || 1
                      }))
                    : [],
                revisions: Array.isArray(parsed.revisions)
                    ? parsed.revisions
                    : [],
                health:
                    parsed.health && typeof parsed.health === 'object'
                        ? parsed.health
                        : {},
                debrid: parsed.debrid,
                grants:
                    parsed.grants && typeof parsed.grants === 'object'
                        ? parsed.grants
                        : {},
                audit: Array.isArray(parsed.audit) ? parsed.audit : [],
                jobs:
                    parsed.jobs && typeof parsed.jobs === 'object'
                        ? parsed.jobs
                        : {},
                outbox: Array.isArray(parsed.outbox) ? parsed.outbox : []
            };
            globalMetrics.recordStorageOperation('file_read', 'ok', Date.now() - t0);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                globalMetrics.recordStorageOperation('file_read', 'ok', Date.now() - t0);
                await this.persist();
                return;
            }
            globalMetrics.recordStorageOperation('file_read', 'error', Date.now() - t0);
            console.warn(
                `[storage:file] Failed to read ${this.file}, initializing empty:`,
                err instanceof Error ? err.message : err
            );
            await this.persist();
        }
    }

    private async persist(): Promise<void> {
        const t0 = Date.now();
        try {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.${fileCounter++}.tmp`;
            const json = JSON.stringify(this.data, null, 2);
            await fs.writeFile(tmp, json, 'utf-8');
            await fs.rename(tmp, this.file);
            globalMetrics.recordStorageOperation('file_write', 'ok', Date.now() - t0);
        } catch (err) {
            globalMetrics.recordStorageOperation('file_write', 'error', Date.now() - t0);
            throw err;
        }
    }

    async getRevision(): Promise<number> {
        return this.data.revision;
    }

    async bumpRevision(action: string, actor?: string): Promise<number> {
        return this.runExclusive(async () => {
            this.data.revision++;
            const revRecord: AddonRevisionRecord = {
                id: nanoid(),
                revision: this.data.revision,
                mutatedBy: actor,
                action,
                createdAt: new Date().toISOString()
            };
            this.data.revisions.push(revRecord);
            // Cap revisions log
            if (this.data.revisions.length > 200) {
                this.data.revisions = this.data.revisions.slice(-200);
            }
            await this.persist();
            return this.data.revision;
        });
    }

    async listAddons(): Promise<AddonRecord[]> {
        return [...this.data.addons].sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return a.name.localeCompare(b.name);
        });
    }

    async getAddon(providerId: string): Promise<AddonRecord | null> {
        return (
            this.data.addons.find((a) => a.providerId === providerId) ?? null
        );
    }

    async saveAddon(
        addon: AddonRecord,
        expectedVersion?: number,
        outboxJob?: { type: string; payload: Record<string, unknown> }
    ): Promise<AddonRecord> {
        return this.runExclusive(async () => {
            const idx = this.data.addons.findIndex(
                (a) => a.providerId === addon.providerId
            );
            const existing = idx >= 0 ? this.data.addons[idx] : null;

            if (expectedVersion !== undefined && existing) {
                if (existing.version !== expectedVersion) {
                    throw new OptimisticLockError(
                        'addon',
                        addon.providerId,
                        expectedVersion,
                        existing.version
                    );
                }
            }

            const newVersion = (existing ? existing.version : 0) + 1;
            const updated: AddonRecord = {
                ...addon,
                version: newVersion,
                updatedAt: new Date().toISOString()
            };

            if (idx >= 0) {
                this.data.addons[idx] = updated;
            } else {
                this.data.addons.push(updated);
            }

            if (outboxJob) {
                this.data.outbox.push({
                    id: nanoid(),
                    jobType: outboxJob.type,
                    payload: outboxJob.payload,
                    status: 'pending',
                    createdAt: Date.now()
                });
            }

            this.data.revision++;
            await this.persist();
            return updated;
        });
    }

    async removeAddon(
        providerId: string,
        outboxJob?: { type: string; payload: Record<string, unknown> }
    ): Promise<boolean> {
        return this.runExclusive(async () => {
            const idx = this.data.addons.findIndex(
                (a) => a.providerId === providerId
            );
            if (idx < 0) return false;

            this.data.addons.splice(idx, 1);
            if (outboxJob) {
                this.data.outbox.push({
                    id: nanoid(),
                    jobType: outboxJob.type,
                    payload: outboxJob.payload,
                    status: 'pending',
                    createdAt: Date.now()
                });
            }

            this.data.revision++;
            await this.persist();
            return true;
        });
    }

    async reorderAddons(order: string[]): Promise<void> {
        return this.runExclusive(async () => {
            const map = new Map<string, number>();
            order.forEach((id, i) => map.set(id, i));
            let fallback = order.length;
            for (const addon of this.data.addons) {
                addon.order = map.has(addon.providerId)
                    ? (map.get(addon.providerId) as number)
                    : fallback++;
                addon.version = (addon.version || 1) + 1;
            }
            this.data.revision++;
            await this.persist();
        });
    }

    async getDebridConfig(): Promise<DebridConfigRecord | null> {
        return this.data.debrid ?? null;
    }

    async saveDebridConfig(config: DebridConfigRecord): Promise<void> {
        return this.runExclusive(async () => {
            this.data.debrid = {
                ...config,
                updatedAt: new Date().toISOString()
            };
            await this.persist();
        });
    }

    async recordHealth(health: AddonHealthRecord): Promise<void> {
        return this.runExclusive(async () => {
            this.data.health[health.providerId] = {
                ...health,
                checkedAt: health.checkedAt || new Date().toISOString()
            };
            // Also update embedded health on addon record if present
            const addon = this.data.addons.find(
                (a) => a.providerId === health.providerId
            );
            if (addon) {
                addon.health = {
                    healthy: health.healthy,
                    lastChecked: health.checkedAt || new Date().toISOString(),
                    error: health.error
                };
            }
            await this.persist();
        });
    }

    async getHealth(providerId: string): Promise<AddonHealthRecord | null> {
        return this.data.health[providerId] ?? null;
    }

    async listHealth(): Promise<AddonHealthRecord[]> {
        return Object.values(this.data.health);
    }

    async saveGrant(grant: PlaybackGrantRecord): Promise<void> {
        return this.runExclusive(async () => {
            this.data.grants[grant.id] = { ...grant };
            await this.persist();
        });
    }

    async getGrant(id: string): Promise<PlaybackGrantRecord | null> {
        return this.data.grants[id] ?? null;
    }

    async consumeGrant(id: string): Promise<PlaybackGrantRecord | null> {
        return this.runExclusive(async () => {
            const g = this.data.grants[id];
            if (!g) return null;
            const now = Math.floor(Date.now() / 1000);
            if (g.expiresAt <= now) return null;
            if (g.singleUse && g.used) return null;
            g.used = true;
            await this.persist();
            return g;
        });
    }

    async revokeGrant(id: string): Promise<boolean> {
        return this.runExclusive(async () => {
            if (this.data.grants[id]) {
                delete this.data.grants[id];
                await this.persist();
                return true;
            }
            return false;
        });
    }

    async cleanupExpiredGrants(
        now = Math.floor(Date.now() / 1000)
    ): Promise<number> {
        return this.runExclusive(async () => {
            let removed = 0;
            for (const [k, v] of Object.entries(this.data.grants)) {
                if (v.expiresAt <= now) {
                    delete this.data.grants[k];
                    removed++;
                }
            }
            if (removed > 0) await this.persist();
            return removed;
        });
    }

    async recordAudit(event: AuditEventRecord): Promise<void> {
        return this.runExclusive(async () => {
            this.data.audit.push({
                ...event,
                id: event.id || nanoid(),
                timestamp: event.timestamp || new Date().toISOString()
            });
            if (this.data.audit.length > 500) {
                this.data.audit = this.data.audit.slice(-500);
            }
            await this.persist();
        });
    }

    async listAudit(limit = 100): Promise<AuditEventRecord[]> {
        return [...this.data.audit]
            .sort(
                (a, b) =>
                    new Date(b.timestamp).getTime() -
                    new Date(a.timestamp).getTime()
            )
            .slice(0, limit);
    }

    async enqueueJob(input: EnqueueJobInput): Promise<JobRecord> {
        return this.runExclusive(async () => {
            const id = input.id || `job_${Date.now()}_${nanoid(6)}`;
            const job: JobRecord = {
                id,
                type: input.type,
                payload: input.payload || {},
                requester: input.requester,
                status: 'queued',
                priority: input.priority ?? 0,
                attempts: 0,
                maxAttempts: input.maxAttempts ?? 3,
                backoffMs: input.backoffMs ?? 1000,
                progress: 0,
                idempotencyKey: input.idempotencyKey,
                dedupKey: input.dedupKey,
                createdAt: Date.now()
            };
            this.data.jobs[id] = job;
            await this.persist();
            return job;
        });
    }

    async getJob(id: string): Promise<JobRecord | null> {
        return this.data.jobs[id] ?? null;
    }

    async getJobByIdempotencyKey(key: string): Promise<JobRecord | null> {
        const matches = Object.values(this.data.jobs).filter(
            (j) => j.idempotencyKey === key
        );
        if (matches.length === 0) return null;
        return matches.sort((a, b) => b.createdAt - a.createdAt)[0];
    }

    async getJobByDedupKey(
        key: string,
        activeOnly = true
    ): Promise<JobRecord | null> {
        const matches = Object.values(this.data.jobs).filter((j) => {
            if (j.dedupKey !== key) return false;
            if (activeOnly)
                return j.status === 'queued' || j.status === 'running';
            return true;
        });
        if (matches.length === 0) return null;
        return matches.sort((a, b) => b.createdAt - a.createdAt)[0];
    }

    async listJobs(filter?: ListJobsFilter): Promise<JobRecord[]> {
        let list = Object.values(this.data.jobs);
        if (filter?.type) {
            list = list.filter((j) => j.type === filter.type);
        }
        if (filter?.status) {
            list = list.filter((j) => j.status === filter.status);
        }
        list.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return b.createdAt - a.createdAt;
        });
        const offset = filter?.offset ?? 0;
        const limit = filter?.limit ?? 50;
        return list.slice(offset, offset + limit);
    }

    async acquireNextJob(
        workerId: string,
        lockDurationMs: number,
        types?: string[]
    ): Promise<JobRecord | null> {
        return this.runExclusive(async () => {
            const now = Date.now();
            const candidates = Object.values(this.data.jobs).filter((j) => {
                if (types && types.length > 0 && !types.includes(j.type))
                    return false;
                if (j.status === 'queued') return true;
                if (
                    j.status === 'running' &&
                    j.lockedUntil &&
                    j.lockedUntil < now
                )
                    return true;
                return false;
            });

            if (candidates.length === 0) return null;

            candidates.sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority;
                return a.createdAt - b.createdAt;
            });

            const chosen = candidates[0];
            chosen.status = 'running';
            chosen.lockedBy = workerId;
            chosen.lockedUntil = now + lockDurationMs;
            chosen.startedAt = chosen.startedAt || now;
            chosen.attempts++;

            await this.persist();
            return { ...chosen };
        });
    }

    async updateJobProgress(
        id: string,
        progress: number,
        workerId: string
    ): Promise<void> {
        return this.runExclusive(async () => {
            const job = this.data.jobs[id];
            if (job && (job.lockedBy === workerId || !job.lockedBy)) {
                job.progress = Math.max(0, Math.min(100, progress));
                await this.persist();
            }
        });
    }

    async heartbeatJob(
        id: string,
        workerId: string,
        lockDurationMs: number
    ): Promise<boolean> {
        return this.runExclusive(async () => {
            const job = this.data.jobs[id];
            if (job && job.lockedBy === workerId) {
                job.lockedUntil = Date.now() + lockDurationMs;
                await this.persist();
                return true;
            }
            return false;
        });
    }

    async completeJob(
        id: string,
        result: unknown,
        workerId: string
    ): Promise<void> {
        return this.runExclusive(async () => {
            const job = this.data.jobs[id];
            if (job && (job.lockedBy === workerId || !job.lockedBy)) {
                job.status = 'completed';
                job.progress = 100;
                job.result = result;
                job.finishedAt = Date.now();
                job.lockedBy = undefined;
                job.lockedUntil = undefined;
                await this.persist();
            }
        });
    }

    async failJob(
        id: string,
        error: string,
        workerId: string,
        retryable = true
    ): Promise<JobRecord> {
        return this.runExclusive(async () => {
            const job = this.data.jobs[id];
            if (!job) throw new Error(`Job ${id} not found`);

            const shouldRetry = retryable && job.attempts < job.maxAttempts;
            job.status = shouldRetry ? 'queued' : 'dead_letter';
            job.error = error;
            job.lockedBy = undefined;
            job.lockedUntil = undefined;
            if (job.status === 'dead_letter') {
                job.finishedAt = Date.now();
            }
            await this.persist();
            return { ...job };
        });
    }

    async cancelJob(id: string): Promise<boolean> {
        return this.runExclusive(async () => {
            const job = this.data.jobs[id];
            if (job && (job.status === 'queued' || job.status === 'running')) {
                job.status = 'cancelled';
                job.error = 'Job cancelled by operator';
                job.finishedAt = Date.now();
                job.lockedBy = undefined;
                job.lockedUntil = undefined;
                await this.persist();
                return true;
            }
            return false;
        });
    }

    async cleanupJobs(maxAgeMs: number): Promise<number> {
        return this.runExclusive(async () => {
            const cutoff = Date.now() - maxAgeMs;
            let removed = 0;
            for (const [k, v] of Object.entries(this.data.jobs)) {
                if (
                    ['completed', 'cancelled', 'dead_letter'].includes(
                        v.status
                    ) &&
                    v.finishedAt &&
                    v.finishedAt < cutoff
                ) {
                    delete this.data.jobs[k];
                    removed++;
                }
            }
            if (removed > 0) await this.persist();
            return removed;
        });
    }

    async drainOutbox(batchSize = 20): Promise<OutboxRecord[]> {
        return this.data.outbox
            .filter((o) => o.status === 'pending')
            .slice(0, batchSize);
    }

    async markOutboxProcessed(id: string): Promise<void> {
        return this.runExclusive(async () => {
            const o = this.data.outbox.find((x) => x.id === id);
            if (o) {
                o.status = 'processed';
                o.processedAt = Date.now();
                await this.persist();
            }
        });
    }

    async exportSanitized(): Promise<SanitizedExportData> {
        const addons = await this.listAddons();
        return {
            version: 1,
            revision: this.data.revision,
            addons: addons.map((a) => ({
                providerId: a.providerId,
                slug: a.slug,
                name: a.name,
                enabled: a.enabled,
                admissionState: a.admissionState,
                validationFindings: a.validationFindings,
                order: a.order,
                timeoutMs: a.timeoutMs,
                source: a.source,
                manifest: a.manifest,
                capabilities: a.capabilities,
                addedAt: a.addedAt,
                updatedAt: a.updatedAt
            })),
            exportedAt: new Date().toISOString()
        };
    }
}
