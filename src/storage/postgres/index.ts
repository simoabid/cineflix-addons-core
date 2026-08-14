import { nanoid } from 'nanoid';
import type { AppConfig } from '../../config.js';
import { globalMetrics } from '../../metrics/index.js';
import {
    type IStorageBackend,
    type AddonRecord,
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
import { runMigrations, type Queryable } from '../migrations/index.js';

interface PgPoolClient extends Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
}

interface PgPool extends Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    connect(): Promise<PgPoolClient>;
    end(): Promise<void>;
}

export class PostgresStorageBackend implements IStorageBackend {
    private pool: PgPool | null = null;
    private readonly connectionString: string;

    constructor(
        private readonly cfg: AppConfig,
        connectionString?: string
    ) {
        this.connectionString =
            connectionString ||
            process.env.DATABASE_URL ||
            `postgresql://${process.env.PGUSER || 'postgres'}:${encodeURIComponent(process.env.PGPASSWORD || '')}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'addons_core'}`;
    }

    private async getPool(): Promise<PgPool> {
        if (this.pool) return this.pool;
        try {
            const moduleName = 'pg';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pgMod = (await import(moduleName)) as any;
            const PoolClass = pgMod.default?.Pool ?? pgMod.Pool;
            const rawPool = new PoolClass({
                connectionString: this.connectionString,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000
            }) as PgPool;

            const origQuery = rawPool.query.bind(rawPool);
            rawPool.query = async (sql: string, params?: unknown[]) => {
                const t0 = Date.now();
                try {
                    const res = await origQuery(sql, params);
                    globalMetrics.recordStorageOperation(
                        'pg_query',
                        'ok',
                        Date.now() - t0
                    );
                    return res;
                } catch (err) {
                    globalMetrics.recordStorageOperation(
                        'pg_query',
                        'error',
                        Date.now() - t0
                    );
                    throw err;
                }
            };
            this.pool = rawPool;
            return this.pool;
        } catch (err) {
            throw new Error(
                `ADDONS_STORE=postgres requires the 'pg' package. Install it via: npm i pg @types/pg. Details: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    async init(): Promise<void> {
        const pool = await this.getPool();
        // Run migrations
        await runMigrations(pool);

        // Initialize store_metadata revision if missing
        await pool.query(`
            INSERT INTO store_metadata (key, value)
            VALUES ('revision', '0')
            ON CONFLICT (key) DO NOTHING;
        `);
    }

    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }

    describe(): string {
        const masked = this.connectionString.replace(/:[^:@]*@/, ':***@');
        return `postgres:${masked}`;
    }

    async getRevision(): Promise<number> {
        const pool = await this.getPool();
        const res = await pool.query(
            "SELECT value FROM store_metadata WHERE key = 'revision'"
        );
        if (res.rows.length === 0) return 0;
        return Number((res.rows[0] as { value: string }).value) || 0;
    }

    async bumpRevision(action: string, actor?: string): Promise<number> {
        const pool = await this.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(`
                UPDATE store_metadata
                SET value = (COALESCE(value::integer, 0) + 1)::text
                WHERE key = 'revision'
                RETURNING value;
            `);
            const rev = Number((res.rows[0] as { value: string }).value);
            await client.query(
                `
                INSERT INTO addon_revisions (id, revision, mutated_by, action, created_at)
                VALUES ($1, $2, $3, $4, $5);
            `,
                [nanoid(), rev, actor || null, action, new Date().toISOString()]
            );
            await client.query('COMMIT');
            return rev;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async listAddons(): Promise<AddonRecord[]> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM addons ORDER BY sort_order ASC, name ASC'
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return res.rows.map((r: any) => this.mapRowToAddon(r));
    }

    async getAddon(providerId: string): Promise<AddonRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM addons WHERE provider_id = $1',
            [providerId]
        );
        if (res.rows.length === 0) return null;
        return this.mapRowToAddon(res.rows[0]);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapRowToAddon(r: any): AddonRecord {
        return {
            providerId: r.provider_id,
            slug: r.slug,
            name: r.name,
            originalImportUrl: r.original_import_url || undefined,
            manifestUrl: r.manifest_url,
            baseUrl: r.base_url,
            enabled: Boolean(r.enabled),
            admissionState: r.admission_state,
            validationFindings: r.validation_findings
                ? JSON.parse(r.validation_findings)
                : undefined,
            order: Number(r.sort_order),
            timeoutMs: Number(r.timeout_ms),
            source: r.source,
            manifest: JSON.parse(r.manifest),
            capabilities: r.capabilities
                ? JSON.parse(r.capabilities)
                : undefined,
            version: Number(r.version),
            addedAt: r.added_at,
            updatedAt: r.updated_at
        };
    }

    async saveAddon(
        addon: AddonRecord,
        expectedVersion?: number,
        outboxJob?: { type: string; payload: Record<string, unknown> }
    ): Promise<AddonRecord> {
        const pool = await this.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const existingRes = await client.query(
                'SELECT version FROM addons WHERE provider_id = $1 FOR UPDATE',
                [addon.providerId]
            );

            const existing = existingRes.rows[0] as
                { version: number } | undefined;
            const newVersion = (existing ? Number(existing.version) : 0) + 1;

            if (expectedVersion !== undefined && existing) {
                if (Number(existing.version) !== expectedVersion) {
                    throw new OptimisticLockError(
                        'addon',
                        addon.providerId,
                        expectedVersion,
                        Number(existing.version)
                    );
                }
            }

            const updatedAddon: AddonRecord = {
                ...addon,
                version: newVersion,
                updatedAt: new Date().toISOString()
            };

            await client.query(
                `
                INSERT INTO addons (
                    provider_id, slug, name, original_import_url, manifest_url,
                    base_url, enabled, admission_state, validation_findings,
                    sort_order, timeout_ms, source, manifest, capabilities,
                    version, added_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                ON CONFLICT (provider_id) DO UPDATE SET
                    slug = EXCLUDED.slug,
                    name = EXCLUDED.name,
                    original_import_url = EXCLUDED.original_import_url,
                    manifest_url = EXCLUDED.manifest_url,
                    base_url = EXCLUDED.base_url,
                    enabled = EXCLUDED.enabled,
                    admission_state = EXCLUDED.admission_state,
                    validation_findings = EXCLUDED.validation_findings,
                    sort_order = EXCLUDED.sort_order,
                    timeout_ms = EXCLUDED.timeout_ms,
                    source = EXCLUDED.source,
                    manifest = EXCLUDED.manifest,
                    capabilities = EXCLUDED.capabilities,
                    version = EXCLUDED.version,
                    updated_at = EXCLUDED.updated_at;
            `,
                [
                    updatedAddon.providerId,
                    updatedAddon.slug,
                    updatedAddon.name,
                    updatedAddon.originalImportUrl || null,
                    updatedAddon.manifestUrl,
                    updatedAddon.baseUrl,
                    updatedAddon.enabled,
                    updatedAddon.admissionState || 'validated',
                    updatedAddon.validationFindings
                        ? JSON.stringify(updatedAddon.validationFindings)
                        : null,
                    updatedAddon.order,
                    updatedAddon.timeoutMs,
                    updatedAddon.source,
                    JSON.stringify(updatedAddon.manifest),
                    updatedAddon.capabilities
                        ? JSON.stringify(updatedAddon.capabilities)
                        : null,
                    updatedAddon.version,
                    updatedAddon.addedAt || new Date().toISOString(),
                    updatedAddon.updatedAt
                ]
            );

            // If outbox job supplied, record in same transaction
            if (outboxJob) {
                await client.query(
                    `
                    INSERT INTO job_outbox (id, job_type, payload_json, status, created_at)
                    VALUES ($1, $2, $3, 'pending', $4);
                `,
                    [
                        nanoid(),
                        outboxJob.type,
                        JSON.stringify(outboxJob.payload),
                        Date.now()
                    ]
                );
            }

            // Bump revision transactionally
            await client.query(`
                UPDATE store_metadata
                SET value = (COALESCE(value::integer, 0) + 1)::text
                WHERE key = 'revision';
            `);

            await client.query('COMMIT');
            return updatedAddon;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async removeAddon(
        providerId: string,
        outboxJob?: { type: string; payload: Record<string, unknown> }
    ): Promise<boolean> {
        const pool = await this.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                'DELETE FROM addons WHERE provider_id = $1 RETURNING provider_id',
                [providerId]
            );
            if (res.rows.length === 0) {
                await client.query('COMMIT');
                return false;
            }

            if (outboxJob) {
                await client.query(
                    `
                    INSERT INTO job_outbox (id, job_type, payload_json, status, created_at)
                    VALUES ($1, $2, $3, 'pending', $4);
                `,
                    [
                        nanoid(),
                        outboxJob.type,
                        JSON.stringify(outboxJob.payload),
                        Date.now()
                    ]
                );
            }

            await client.query(`
                UPDATE store_metadata
                SET value = (COALESCE(value::integer, 0) + 1)::text
                WHERE key = 'revision';
            `);

            await client.query('COMMIT');
            return true;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async reorderAddons(order: string[]): Promise<void> {
        const pool = await this.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (let i = 0; i < order.length; i++) {
                await client.query(
                    'UPDATE addons SET sort_order = $1 WHERE provider_id = $2',
                    [i, order[i]]
                );
            }
            await client.query(`
                UPDATE store_metadata
                SET value = (COALESCE(value::integer, 0) + 1)::text
                WHERE key = 'revision';
            `);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async getDebridConfig(): Promise<DebridConfigRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM debrid_configurations LIMIT 1'
        );
        if (res.rows.length === 0) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = res.rows[0];
        return {
            id: r.id,
            provider: r.provider,
            apiKeyCiphertext: r.api_key_ciphertext || undefined,
            updatedAt: r.updated_at
        };
    }

    async saveDebridConfig(config: DebridConfigRecord): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            `
            INSERT INTO debrid_configurations (id, provider, api_key_ciphertext, updated_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE SET
                provider = EXCLUDED.provider,
                api_key_ciphertext = EXCLUDED.api_key_ciphertext,
                updated_at = EXCLUDED.updated_at;
        `,
            [
                config.id || 'default',
                config.provider,
                config.apiKeyCiphertext || null,
                config.updatedAt || new Date().toISOString()
            ]
        );
    }

    async recordHealth(health: AddonHealthRecord): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            `
            INSERT INTO addon_health_checks (provider_id, healthy, error, checked_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (provider_id) DO UPDATE SET
                healthy = EXCLUDED.healthy,
                error = EXCLUDED.error,
                checked_at = EXCLUDED.checked_at;
        `,
            [
                health.providerId,
                health.healthy,
                health.error || null,
                health.checkedAt || new Date().toISOString()
            ]
        );
    }

    async getHealth(providerId: string): Promise<AddonHealthRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM addon_health_checks WHERE provider_id = $1',
            [providerId]
        );
        if (res.rows.length === 0) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = res.rows[0];
        return {
            providerId: r.provider_id,
            healthy: Boolean(r.healthy),
            error: r.error || undefined,
            checkedAt: r.checked_at
        };
    }

    async listHealth(): Promise<AddonHealthRecord[]> {
        const pool = await this.getPool();
        const res = await pool.query('SELECT * FROM addon_health_checks');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return res.rows.map((r: any) => ({
            providerId: r.provider_id,
            healthy: Boolean(r.healthy),
            error: r.error || undefined,
            checkedAt: r.checked_at
        }));
    }

    async saveGrant(grant: PlaybackGrantRecord): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            `
            INSERT INTO playback_grants (
                id, url, headers_json, provider_id, media_key,
                expires_at, created_at, max_redirects, single_use, used, addon_revision
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO UPDATE SET
                used = EXCLUDED.used;
        `,
            [
                grant.id,
                grant.url,
                grant.headersJson,
                grant.providerId || null,
                grant.mediaKey || null,
                grant.expiresAt,
                grant.createdAt,
                grant.maxRedirects,
                grant.singleUse,
                grant.used,
                grant.addonRevision || null
            ]
        );
    }

    async getGrant(id: string): Promise<PlaybackGrantRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM playback_grants WHERE id = $1',
            [id]
        );
        if (res.rows.length === 0) return null;
        return this.mapRowToGrant(res.rows[0]);
    }

    async consumeGrant(id: string): Promise<PlaybackGrantRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query(
            `
            UPDATE playback_grants
            SET used = TRUE
            WHERE id = $1 AND (used = FALSE OR single_use = FALSE) AND expires_at > $2
            RETURNING *;
        `,
            [id, Math.floor(Date.now() / 1000)]
        );
        if (res.rows.length === 0) return null;
        return this.mapRowToGrant(res.rows[0]);
    }

    async revokeGrant(id: string): Promise<boolean> {
        const pool = await this.getPool();
        const res = await pool.query(
            'DELETE FROM playback_grants WHERE id = $1 RETURNING id',
            [id]
        );
        return res.rows.length > 0;
    }

    async cleanupExpiredGrants(
        now = Math.floor(Date.now() / 1000)
    ): Promise<number> {
        const pool = await this.getPool();
        const res = await pool.query(
            'DELETE FROM playback_grants WHERE expires_at <= $1 RETURNING id',
            [now]
        );
        return res.rows.length;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapRowToGrant(r: any): PlaybackGrantRecord {
        return {
            id: r.id,
            url: r.url,
            headersJson: r.headers_json,
            providerId: r.provider_id || undefined,
            mediaKey: r.media_key || undefined,
            expiresAt: Number(r.expires_at),
            createdAt: Number(r.created_at),
            maxRedirects: Number(r.max_redirects),
            singleUse: Boolean(r.single_use),
            used: Boolean(r.used),
            addonRevision: r.addon_revision
                ? Number(r.addon_revision)
                : undefined
        };
    }

    async recordAudit(event: AuditEventRecord): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            `
            INSERT INTO audit_events (
                id, actor_json, action, target, request_id, revision,
                outcome, before_json, after_json, reason, meta_json, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);
        `,
            [
                event.id || nanoid(),
                event.actorJson,
                event.action,
                event.target || null,
                event.requestId || null,
                event.revision || null,
                event.outcome,
                event.beforeJson || null,
                event.afterJson || null,
                event.reason || null,
                event.metaJson || null,
                event.timestamp || new Date().toISOString()
            ]
        );
    }

    async listAudit(limit = 100): Promise<AuditEventRecord[]> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT $1',
            [limit]
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return res.rows.map((r: any) => ({
            id: r.id,
            actorJson: r.actor_json,
            action: r.action,
            target: r.target || undefined,
            requestId: r.request_id || undefined,
            revision: r.revision ? Number(r.revision) : undefined,
            outcome: r.outcome,
            beforeJson: r.before_json || undefined,
            afterJson: r.after_json || undefined,
            reason: r.reason || undefined,
            metaJson: r.meta_json || undefined,
            timestamp: r.timestamp
        }));
    }

    // Job system methods
    async enqueueJob(input: EnqueueJobInput): Promise<JobRecord> {
        const pool = await this.getPool();
        const id = input.id || `job_${Date.now()}_${nanoid(6)}`;
        const now = Date.now();
        const record: JobRecord = {
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
            createdAt: now
        };

        await pool.query(
            `
            INSERT INTO jobs (
                id, type, payload_json, requester_json, status,
                priority, attempts, max_attempts, backoff_ms, progress,
                idempotency_key, dedup_key, created_at
            ) VALUES ($1, $2, $3, $4, 'queued', $5, 0, $6, $7, 0, $8, $9, $10);
        `,
            [
                record.id,
                record.type,
                JSON.stringify(record.payload),
                record.requester ? JSON.stringify(record.requester) : null,
                record.priority,
                record.maxAttempts,
                record.backoffMs,
                record.idempotencyKey || null,
                record.dedupKey || null,
                record.createdAt
            ]
        );

        return record;
    }

    async getJob(id: string): Promise<JobRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
        if (res.rows.length === 0) return null;
        return this.mapRowToJob(res.rows[0]);
    }

    async getJobByIdempotencyKey(key: string): Promise<JobRecord | null> {
        const pool = await this.getPool();
        const res = await pool.query(
            'SELECT * FROM jobs WHERE idempotency_key = $1 ORDER BY created_at DESC LIMIT 1',
            [key]
        );
        if (res.rows.length === 0) return null;
        return this.mapRowToJob(res.rows[0]);
    }

    async getJobByDedupKey(
        key: string,
        activeOnly = true
    ): Promise<JobRecord | null> {
        const pool = await this.getPool();
        const sql = activeOnly
            ? "SELECT * FROM jobs WHERE dedup_key = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1"
            : 'SELECT * FROM jobs WHERE dedup_key = $1 ORDER BY created_at DESC LIMIT 1';
        const res = await pool.query(sql, [key]);
        if (res.rows.length === 0) return null;
        return this.mapRowToJob(res.rows[0]);
    }

    async listJobs(filter?: ListJobsFilter): Promise<JobRecord[]> {
        const pool = await this.getPool();
        const params: unknown[] = [];
        const where: string[] = [];

        if (filter?.type) {
            params.push(filter.type);
            where.push(`type = $${params.length}`);
        }
        if (filter?.status) {
            params.push(filter.status);
            where.push(`status = $${params.length}`);
        }

        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const limit = filter?.limit ?? 50;
        const offset = filter?.offset ?? 0;
        params.push(limit, offset);

        const sql = `
            SELECT * FROM jobs
            ${whereSql}
            ORDER BY priority DESC, created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `;
        const res = await pool.query(sql, params);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return res.rows.map((r: any) => this.mapRowToJob(r));
    }

    async acquireNextJob(
        workerId: string,
        lockDurationMs: number,
        types?: string[]
    ): Promise<JobRecord | null> {
        const pool = await this.getPool();
        const client = await pool.connect();
        const now = Date.now();
        const lockUntil = now + lockDurationMs;

        try {
            await client.query('BEGIN');
            let typeClause = '';
            const params: unknown[] = [now];
            if (types && types.length > 0) {
                params.push(types);
                typeClause = `AND type = ANY($${params.length})`;
            }

            const candidateSql = `
                SELECT id FROM jobs
                WHERE (status = 'queued' OR (status = 'running' AND locked_until < $1))
                ${typeClause}
                ORDER BY priority DESC, created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED;
            `;
            const candRes = await client.query(candidateSql, params);
            if (candRes.rows.length === 0) {
                await client.query('COMMIT');
                return null;
            }

            const jobId = (candRes.rows[0] as { id: string }).id;
            const updateRes = await client.query(
                `
                UPDATE jobs
                SET status = 'running',
                    locked_by = $1,
                    locked_until = $2,
                    started_at = COALESCE(started_at, $3),
                    attempts = attempts + 1
                WHERE id = $4
                RETURNING *;
            `,
                [workerId, lockUntil, now, jobId]
            );

            await client.query('COMMIT');
            if (updateRes.rows.length === 0) return null;
            return this.mapRowToJob(updateRes.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async updateJobProgress(
        id: string,
        progress: number,
        workerId: string
    ): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            'UPDATE jobs SET progress = $1 WHERE id = $2 AND locked_by = $3',
            [Math.max(0, Math.min(100, progress)), id, workerId]
        );
    }

    async heartbeatJob(
        id: string,
        workerId: string,
        lockDurationMs: number
    ): Promise<boolean> {
        const pool = await this.getPool();
        const lockUntil = Date.now() + lockDurationMs;
        const res = await pool.query(
            'UPDATE jobs SET locked_until = $1 WHERE id = $2 AND locked_by = $3 RETURNING id',
            [lockUntil, id, workerId]
        );
        return res.rows.length > 0;
    }

    async completeJob(
        id: string,
        result: unknown,
        workerId: string
    ): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            `
            UPDATE jobs
            SET status = 'completed',
                progress = 100,
                result_json = $1,
                finished_at = $2,
                locked_by = NULL,
                locked_until = NULL
            WHERE id = $3 AND (locked_by = $4 OR locked_by IS NULL);
        `,
            [result ? JSON.stringify(result) : null, Date.now(), id, workerId]
        );
    }

    async failJob(
        id: string,
        error: string,
        workerId: string,
        retryable = true
    ): Promise<JobRecord> {
        const pool = await this.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
                [id]
            );
            if (res.rows.length === 0) {
                await client.query('COMMIT');
                throw new Error(`Job ${id} not found`);
            }
            const job = this.mapRowToJob(res.rows[0]);
            const shouldRetry = retryable && job.attempts < job.maxAttempts;
            const newStatus: JobRecord['status'] = shouldRetry
                ? 'queued'
                : 'dead_letter';

            const updateRes = await client.query(
                `
                UPDATE jobs
                SET status = $1,
                    error = $2,
                    finished_at = CASE WHEN $1 = 'dead_letter' THEN $3 ELSE NULL END,
                    locked_by = NULL,
                    locked_until = NULL
                WHERE id = $4
                RETURNING *;
            `,
                [newStatus, error, Date.now(), id]
            );

            await client.query('COMMIT');
            return this.mapRowToJob(updateRes.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async cancelJob(id: string): Promise<boolean> {
        const pool = await this.getPool();
        const res = await pool.query(
            `
            UPDATE jobs
            SET status = 'cancelled',
                finished_at = $1,
                error = 'Job cancelled by operator',
                locked_by = NULL,
                locked_until = NULL
            WHERE id = $2 AND status IN ('queued', 'running')
            RETURNING id;
        `,
            [Date.now(), id]
        );
        return res.rows.length > 0;
    }

    async cleanupJobs(maxAgeMs: number): Promise<number> {
        const pool = await this.getPool();
        const cutoff = Date.now() - maxAgeMs;
        const res = await pool.query(
            `
            DELETE FROM jobs
            WHERE status IN ('completed', 'cancelled', 'dead_letter')
              AND finished_at IS NOT NULL
              AND finished_at < $1
            RETURNING id;
        `,
            [cutoff]
        );
        return res.rows.length;
    }

    async drainOutbox(batchSize = 20): Promise<OutboxRecord[]> {
        const pool = await this.getPool();
        const res = await pool.query(
            `
            SELECT * FROM job_outbox
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT $1;
        `,
            [batchSize]
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return res.rows.map((r: any) => ({
            id: r.id,
            jobType: r.job_type,
            payload: JSON.parse(r.payload_json),
            status: r.status,
            createdAt: Number(r.created_at),
            processedAt: r.processed_at ? Number(r.processed_at) : undefined
        }));
    }

    async markOutboxProcessed(id: string): Promise<void> {
        const pool = await this.getPool();
        await pool.query(
            `
            UPDATE job_outbox
            SET status = 'processed', processed_at = $1
            WHERE id = $2;
        `,
            [Date.now(), id]
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapRowToJob(r: any): JobRecord {
        return {
            id: r.id,
            type: r.type,
            payload: JSON.parse(r.payload_json || '{}'),
            requester: r.requester_json
                ? JSON.parse(r.requester_json)
                : undefined,
            status: r.status,
            priority: Number(r.priority),
            attempts: Number(r.attempts),
            maxAttempts: Number(r.max_attempts),
            backoffMs: Number(r.backoff_ms),
            progress: Number(r.progress),
            result: r.result_json ? JSON.parse(r.result_json) : undefined,
            error: r.error || undefined,
            idempotencyKey: r.idempotency_key || undefined,
            dedupKey: r.dedup_key || undefined,
            lockedBy: r.locked_by || undefined,
            lockedUntil: r.locked_until ? Number(r.locked_until) : undefined,
            createdAt: Number(r.created_at),
            startedAt: r.started_at ? Number(r.started_at) : undefined,
            finishedAt: r.finished_at ? Number(r.finished_at) : undefined
        };
    }

    async exportSanitized(): Promise<SanitizedExportData> {
        const addons = await this.listAddons();
        const revision = await this.getRevision();
        return {
            version: 1,
            revision,
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
