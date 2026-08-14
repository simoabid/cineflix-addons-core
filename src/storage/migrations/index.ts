export interface Migration {
    version: number;
    name: string;
    up: string;
    down?: string;
}

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: '001_initial_phase3_schema',
        up: `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addons (
    provider_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    original_import_url TEXT,
    manifest_url TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    admission_state TEXT NOT NULL DEFAULT 'validated',
    validation_findings TEXT,
    sort_order INTEGER NOT NULL DEFAULT 100,
    timeout_ms INTEGER NOT NULL DEFAULT 10000,
    source TEXT NOT NULL DEFAULT 'manual',
    manifest TEXT NOT NULL,
    capabilities TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addon_revisions (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    mutated_by TEXT,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addon_health_checks (
    provider_id TEXT PRIMARY KEY,
    healthy BOOLEAN NOT NULL,
    error TEXT,
    checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS debrid_configurations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    api_key_ciphertext TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_grants (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    provider_id TEXT,
    media_key TEXT,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    max_redirects INTEGER NOT NULL DEFAULT 3,
    single_use BOOLEAN NOT NULL DEFAULT FALSE,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    addon_revision INTEGER
);

CREATE INDEX IF NOT EXISTS idx_playback_grants_expires_at ON playback_grants(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_json TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    request_id TEXT,
    revision INTEGER,
    outcome TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    meta_json TEXT,
    timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    requester_json TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    backoff_ms INTEGER NOT NULL DEFAULT 1000,
    progress INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error TEXT,
    idempotency_key TEXT,
    dedup_key TEXT,
    locked_by TEXT,
    locked_until BIGINT,
    created_at BIGINT NOT NULL,
    started_at BIGINT,
    finished_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_created ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_jobs_dedup_key ON jobs(dedup_key);
CREATE INDEX IF NOT EXISTS idx_jobs_locked_until ON jobs(locked_until);

CREATE TABLE IF NOT EXISTS job_outbox (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    processed_at BIGINT
);
`
    }
];

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export async function runMigrations(
    db: Queryable,
    logger = console
): Promise<number> {
    // 1. Ensure migrations table exists
    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at BIGINT NOT NULL
        );
    `);

    // 2. Fetch applied migrations
    const res = await db.query(
        'SELECT version FROM schema_migrations ORDER BY version ASC'
    );
    const applied = new Set(
        (res.rows as Array<{ version: number }>).map((r) => Number(r.version))
    );

    let count = 0;
    for (const m of MIGRATIONS) {
        if (!applied.has(m.version)) {
            logger.log(
                `[migration] Applying migration ${m.version}: ${m.name}`
            );
            // Split up migration queries if necessary or execute whole block
            const statements = m.up
                .split(';')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            for (const stmt of statements) {
                await db.query(stmt);
            }
            await db.query(
                'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
                [m.version, m.name, Date.now()]
            );
            count++;
        }
    }

    if (count > 0) {
        logger.log(`[migration] Successfully applied ${count} migrations`);
    }
    return count;
}
