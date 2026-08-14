import 'dotenv/config';
import path from 'node:path';

/**
 * Centralised environment configuration for addons-core.
 *
 * Everything the server needs is read once here so the rest of the codebase
 * stays free of scattered `process.env` reads. Production fails closed on
 * insecure auth, wildcard CORS, missing public URL, and missing secrets.
 */

function envStr(name: string, fallback = ''): string {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v.trim();
}

function envNum(name: string, fallback: number): number {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return /^(1|true|yes|on)$/i.test(v.trim());
}

function envList(name: string): string[] {
    const v = process.env[name];
    if (!v) return [];
    return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

export type AuthMode =
    'disabled' | 'static-token' | 'oidc' | 'reverse-proxy' | 'service-jwt';

export type Role = 'viewer' | 'operator' | 'admin';

export interface AppConfig {
    name: string;
    version: string;
    host: string;
    port: number;
    publicUrl?: string;
    corsOrigin: string;
    nodeEnv: string;
    internalDebug: boolean;

    tmdbApiKey: string;
    tmdbCacheTTL: number;

    cacheType: 'memory' | 'redis';
    redis: { host: string; port: number; password?: string };

    store: 'file' | 'redis' | 'postgres';
    databaseUrl?: string;
    dataFile: string;
    seedUrls: string[];

    /** Phase 3: Job engine & caching controls */
    jobWorkerConcurrency: number;
    jobPollIntervalMs: number;
    cacheTtlSources: number;
    cacheSwrSec: number;

    adminEnabled: boolean;
    /** @deprecated Prefer authMode + adminToken. Still populated for compat. */
    adminToken?: string;

    /** Phase 1 auth. */
    authMode: AuthMode;
    allowInsecureAdmin: boolean;
    adminTokenRole: Role;
    authSessionSecret?: string;
    serviceJwtSecret?: string;
    proxyUserHeader: string;
    proxyRoleHeader: string;
    trustedProxyCidrs: string[];
    /** Session TTL for admin UI cookie auth (seconds). */
    sessionTtlSec: number;

    enableNativeAddon: boolean;

    /** Debrid via env (takes precedence over persisted settings). */
    debridProvider: string;
    debridApiKey: string;
    debridMaxUserTransfers: number;
    debridMaxGlobalTransfers: number;

    /** Background health/refresh. */
    healthIntervalMinutes: number;
    autoRefresh: boolean;

    /** Secrets / encryption. */
    secretsMasterKey?: string;
    requireSecretsMasterKey: boolean;

    /** Outbound / SSRF policy. */
    allowHttpUpstreams: boolean;
    outboundHostAllowlist: string[];
    outboundHostAllowSuffixes: string[];
    importMaxUrls: number;
    importMaxConcurrent: number;
    importMaxBytes: number;
    importTimeoutMs: number;
    /** New imports start disabled in production unless explicitly enabled. */
    importEnableOnInstall: boolean;

    /** Secure proxy / playback grants. */
    secureProxy: boolean;
    allowLegacyProxy: boolean;
    playbackGrantSecret?: string;
    playbackGrantTtlSec: number;
    proxyTimeoutMs: number;
    proxyMaxManifestBytes: number;
    proxyMaxBufferBytes: number;
    proxyMaxStreamBytes: number;

    /** HTTP limits. */
    maxBodyBytes: number;
    maxQueryLength: number;
    maxHeaderBytes: number;
    maxJsonDepth: number;
    globalRequestTimeoutMs: number;

    /** Audit log path (JSONL). */
    auditLogFile: string;
    auditEnabled: boolean;

    /** Import batch / job controls. */
    importMaxBatchBytes: number;
    importJobTimeoutMs: number;

    /** CSRF. */
    csrfEnabled: boolean;

    /** Phase 6: Telemetry, Observability, and Health Semantics */
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    logFormat: 'json' | 'pretty' | 'text';
    tracingEnabled: boolean;
    tracingPropagateToUpstream: boolean;
    healthStaleThresholdMinutes: number;
    healthDegradedMinProvidersRatio: number;
}

function parseAuthMode(
    raw: string,
    nodeEnv: string,
    hasToken: boolean
): AuthMode {
    const v = raw.trim().toLowerCase();
    const allowed: AuthMode[] = [
        'disabled',
        'static-token',
        'oidc',
        'reverse-proxy',
        'service-jwt'
    ];
    if (allowed.includes(v as AuthMode)) return v as AuthMode;

    // Sensible defaults when AUTH_MODE is unset:
    // - production → static-token (must also set ADMIN_TOKEN)
    // - development with ADMIN_TOKEN → static-token
    // - development without token → disabled (local convenience)
    if (nodeEnv === 'production') return 'static-token';
    if (hasToken) return 'static-token';
    return 'disabled';
}

function parseRole(raw: string, fallback: Role): Role {
    const v = raw.trim().toLowerCase();
    if (v === 'viewer' || v === 'operator' || v === 'admin') return v;
    return fallback;
}

export function loadConfig(): AppConfig {
    const port = envNum('PORT', 3006);
    const host = envStr('HOST', 'localhost');
    const publicUrl = envStr('PUBLIC_URL') || undefined;
    const nodeEnv = envStr('NODE_ENV', 'development');
    const adminToken = envStr('ADMIN_TOKEN') || undefined;
    const authMode = parseAuthMode(
        envStr('AUTH_MODE'),
        nodeEnv,
        Boolean(adminToken)
    );

    const dataFile = envStr('ADDONS_DATA_FILE', './data/addons.json');
    const dataDir = path.dirname(path.resolve(dataFile));

    const isProd = nodeEnv === 'production';

    return {
        name: 'AddonsCore',
        version: '1.0.0',
        host,
        port,
        publicUrl,
        corsOrigin: envStr('CORS_ORIGIN', isProd ? '' : '*'),
        nodeEnv,
        internalDebug: envBool('INTERNAL_DEBUG', false),

        tmdbApiKey: envStr('TMDB_API_KEY'),
        tmdbCacheTTL: envNum('TMDB_CACHE_TTL', 86400),

        cacheType:
            envStr('CACHE_TYPE', isProd ? 'redis' : 'memory') === 'redis'
                ? 'redis'
                : 'memory',
        redis: {
            host: envStr('REDIS_HOST', 'localhost'),
            port: envNum('REDIS_PORT', 6379),
            password: envStr('REDIS_PASSWORD') || undefined
        },

        store: (() => {
            const s = envStr('ADDONS_STORE', 'file').toLowerCase();
            if (s === 'redis') return 'redis';
            if (s === 'postgres' || s === 'postgresql') return 'postgres';
            return 'file';
        })(),
        databaseUrl: envStr('DATABASE_URL') || undefined,
        dataFile,
        seedUrls: envList('ADDONS_SEED_URLS'),

        jobWorkerConcurrency: envNum('JOB_WORKER_CONCURRENCY', 4),
        jobPollIntervalMs: envNum('JOB_POLL_INTERVAL_MS', 1000),
        cacheTtlSources: envNum('CACHE_TTL_SOURCES', 3600),
        cacheSwrSec: envNum('CACHE_SWR_SEC', 300),

        adminEnabled: envBool('ADMIN_ENABLED', true),
        adminToken,

        authMode,
        allowInsecureAdmin: envBool('ALLOW_INSECURE_ADMIN', false),
        adminTokenRole: parseRole(envStr('ADMIN_TOKEN_ROLE'), 'admin'),
        authSessionSecret:
            envStr('AUTH_SESSION_SECRET') || adminToken || undefined,
        serviceJwtSecret: envStr('SERVICE_JWT_SECRET') || undefined,
        proxyUserHeader: envStr('AUTH_PROXY_USER_HEADER', 'x-forwarded-user'),
        proxyRoleHeader: envStr('AUTH_PROXY_ROLE_HEADER', 'x-forwarded-role'),
        trustedProxyCidrs: (() => {
            const raw =
                envStr('TRUSTED_PROXY_CIDRS') ||
                envStr('AUTH_TRUSTED_PROXY_CIDRS');
            if (!raw) return [];
            return raw
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        })(),
        sessionTtlSec: envNum('AUTH_SESSION_TTL_SEC', 8 * 60 * 60),

        enableNativeAddon: envBool('STREMIO_ADDON', false),

        debridProvider: envStr('DEBRID_PROVIDER', 'none'),
        debridApiKey: envStr('DEBRID_API_KEY'),
        debridMaxUserTransfers: envNum('DEBRID_MAX_USER_TRANSFERS', 3),
        debridMaxGlobalTransfers: envNum('DEBRID_MAX_GLOBAL_TRANSFERS', 10),

        healthIntervalMinutes: envNum('ADDON_HEALTH_INTERVAL_MINUTES', 15),
        autoRefresh: envBool('ADDON_AUTO_REFRESH', false),

        secretsMasterKey: envStr('SECRETS_MASTER_KEY') || undefined,
        requireSecretsMasterKey: envBool('REQUIRE_SECRETS_MASTER_KEY', isProd),

        allowHttpUpstreams: envBool('ALLOW_HTTP_UPSTREAMS', !isProd),
        outboundHostAllowlist: envList('OUTBOUND_HOST_ALLOWLIST'),
        outboundHostAllowSuffixes: envList('OUTBOUND_HOST_ALLOW_SUFFIXES'),
        importMaxUrls: envNum('IMPORT_MAX_URLS', 50),
        importMaxConcurrent: envNum('IMPORT_MAX_CONCURRENT', 4),
        importMaxBytes: envNum('IMPORT_MAX_BYTES', 1_048_576),
        importTimeoutMs: envNum('IMPORT_TIMEOUT_MS', 20_000),
        importEnableOnInstall: envBool('IMPORT_ENABLE_ON_INSTALL', !isProd),

        // Secure proxy is on by default; legacy open proxy only when explicitly allowed
        // and never in production.
        secureProxy: envBool('SECURE_PROXY', true),
        allowLegacyProxy: envBool('ALLOW_LEGACY_PROXY', false) && !isProd,
        playbackGrantSecret: isProd
            ? envStr('PLAYBACK_GRANT_SECRET') || undefined
            : envStr('PLAYBACK_GRANT_SECRET') ||
              envStr('AUTH_SESSION_SECRET') ||
              adminToken ||
              undefined,
        playbackGrantTtlSec: envNum('PLAYBACK_GRANT_TTL_SEC', 2 * 60 * 60),
        proxyTimeoutMs: envNum('PROXY_TIMEOUT_MS', 30_000),
        proxyMaxManifestBytes: envNum('PROXY_MAX_MANIFEST_BYTES', 1_048_576),
        proxyMaxBufferBytes: envNum('PROXY_MAX_BUFFER_BYTES', 2_097_152),
        proxyMaxStreamBytes: envNum('PROXY_MAX_STREAM_BYTES', 536_870_912), // 512 MiB default streaming cap

        maxBodyBytes: envNum('MAX_BODY_BYTES', 1_048_576),
        maxQueryLength: envNum('MAX_QUERY_LENGTH', 4096),
        maxHeaderBytes: envNum('MAX_HEADER_BYTES', 16_384),
        maxJsonDepth: envNum('MAX_JSON_DEPTH', 32),
        globalRequestTimeoutMs: envNum('GLOBAL_REQUEST_TIMEOUT_MS', 120_000),

        auditLogFile: envStr(
            'AUDIT_LOG_FILE',
            path.join(dataDir, 'audit.jsonl')
        ),
        auditEnabled: envBool('AUDIT_ENABLED', true),
        importMaxBatchBytes: envNum('IMPORT_MAX_BATCH_BYTES', 5_242_880),
        importJobTimeoutMs: envNum('IMPORT_JOB_TIMEOUT_MS', 60_000),
        csrfEnabled: envBool('CSRF_ENABLED', true),

        logLevel: parseLogLevel(envStr('LOG_LEVEL'), nodeEnv),
        logFormat: parseLogFormat(envStr('LOG_FORMAT'), nodeEnv),
        tracingEnabled: envBool('TRACING_ENABLED', true),
        tracingPropagateToUpstream: envBool(
            'TRACING_PROPAGATE_TO_UPSTREAM',
            false
        ),
        healthStaleThresholdMinutes: envNum(
            'HEALTH_STALE_THRESHOLD_MINUTES',
            60
        ),
        healthDegradedMinProvidersRatio: Math.max(
            0.1,
            Math.min(1.0, envNum('HEALTH_DEGRADED_MIN_RATIO', 0.5))
        )
    };
}

function parseLogLevel(
    raw: string,
    nodeEnv: string
): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
    const v = raw.trim().toLowerCase();
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(v)) {
        return v as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    }
    return nodeEnv === 'production' ? 'info' : 'debug';
}

function parseLogFormat(
    raw: string,
    nodeEnv: string
): 'json' | 'pretty' | 'text' {
    const v = raw.trim().toLowerCase();
    if (['json', 'pretty', 'text'].includes(v)) {
        return v as 'json' | 'pretty' | 'text';
    }
    return nodeEnv === 'production' ? 'json' : 'pretty';
}

/**
 * Fail-closed production validation. Call once at startup before binding.
 * Throws Error with an actionable message on any unsafe combination.
 */
export const DEV_GRANT_SECRET = 'addons-core-dev-grant-secret';

function isWeakSecret(secret: string | undefined): boolean {
    if (!secret) return true;
    if (secret === DEV_GRANT_SECRET) return true;
    if (secret.length < 32) return true;
    // Very low entropy check: all same char or trivial
    if (/^(.)\1+$/.test(secret)) return true;
    return false;
}

function isStrongMasterKey(raw: string | undefined): boolean {
    if (!raw || !raw.trim()) return false;
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return true;
    try {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length === 32) {
            if (/^(.)\1+$/.test(trimmed)) return false;
            if (trimmed.length < 32) return false;
            return true;
        }
    } catch {
        /* fall through */
    }
    return false;
}

export function assertProductionSafe(cfg: AppConfig): void {
    const errors: string[] = [];
    const isProd = cfg.nodeEnv === 'production';

    if (isProd) {
        if (cfg.authMode === 'disabled') {
            errors.push(
                'AUTH_MODE=disabled is not allowed in production. ' +
                    'Set AUTH_MODE=static-token (with ADMIN_TOKEN), reverse-proxy, or service-jwt.'
            );
        }
        if (cfg.authMode === 'static-token' && !cfg.adminToken) {
            errors.push(
                'AUTH_MODE=static-token requires ADMIN_TOKEN to be set in production.'
            );
        }
        if (cfg.authMode === 'service-jwt' && !cfg.serviceJwtSecret) {
            errors.push(
                'AUTH_MODE=service-jwt requires SERVICE_JWT_SECRET in production.'
            );
        }
        if (cfg.authMode === 'oidc') {
            errors.push(
                'AUTH_MODE=oidc is reserved and not fully implemented. Use static-token, reverse-proxy, or service-jwt.'
            );
        }
        if (!cfg.publicUrl) {
            errors.push(
                'PUBLIC_URL is required in production (used for absolute playback grant URLs).'
            );
        } else {
            try {
                const u = new URL(cfg.publicUrl);
                if (u.protocol !== 'https:') {
                    errors.push('PUBLIC_URL must use https:// in production.');
                }
            } catch {
                errors.push('PUBLIC_URL is not a valid URL.');
            }
        }
        if (!cfg.corsOrigin || cfg.corsOrigin === '*') {
            errors.push(
                'CORS_ORIGIN must be an exact allowlist in production (not "*").'
            );
        }
        if (cfg.allowLegacyProxy) {
            errors.push('ALLOW_LEGACY_PROXY cannot be enabled in production.');
        }
        if (!cfg.secureProxy) {
            errors.push('SECURE_PROXY must be enabled in production.');
        }
        if (cfg.requireSecretsMasterKey && !cfg.secretsMasterKey) {
            errors.push(
                'SECRETS_MASTER_KEY is required in production (32-byte key, base64 or hex).'
            );
        }
        if (
            isProd &&
            cfg.secretsMasterKey &&
            !isStrongMasterKey(cfg.secretsMasterKey)
        ) {
            errors.push(
                'SECRETS_MASTER_KEY is too weak: must be 32-byte base64 (44 chars) or 64-char hex, not a short password like "weak". Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
            );
        }
        if (cfg.allowHttpUpstreams) {
            errors.push(
                'ALLOW_HTTP_UPSTREAMS must be false in production (HTTPS only).'
            );
        }
        // Playback grant secret must be explicit and strong in production.
        if (!cfg.playbackGrantSecret) {
            errors.push(
                'PLAYBACK_GRANT_SECRET is required in production (32+ chars, not the dev fallback). ' +
                    'Set a strong random value; it must not be derived from ADMIN_TOKEN.'
            );
        } else if (isWeakSecret(cfg.playbackGrantSecret)) {
            errors.push(
                'PLAYBACK_GRANT_SECRET is too weak or is the default dev value. Use a strong 32+ character random secret.'
            );
        }
        // Reverse-proxy mode must have trusted peer CIDRs configured.
        if (
            cfg.authMode === 'reverse-proxy' &&
            cfg.trustedProxyCidrs.length === 0
        ) {
            errors.push(
                'AUTH_MODE=reverse-proxy requires TRUSTED_PROXY_CIDRS in production (e.g. 10.0.0.0/8,172.16.0.0/12).'
            );
        }
        // Audit must be enabled in production.
        if (!cfg.auditEnabled) {
            errors.push(
                'AUDIT_ENABLED must be true in production (immutable audit is mandatory).'
            );
        }
        if (!cfg.csrfEnabled) {
            errors.push(
                'CSRF_ENABLED must be true in production (CSRF protection is mandatory).'
            );
        }
        // Playback grants must be shared across instances/restarts — require Redis in production.
        if (cfg.cacheType !== 'redis' && cfg.store !== 'redis') {
            errors.push(
                'CACHE_TYPE=redis or ADDONS_STORE=redis is required in production so playback grants and revocation are shared across instances/restarts. ' +
                    'Set CACHE_TYPE=redis and configure REDIS_HOST/REDIS_PORT (requires Redis), or use ADDONS_STORE=redis.'
            );
        }
        // CORS must not contain wildcard members.
        if (cfg.corsOrigin && cfg.corsOrigin !== '*') {
            const parts = cfg.corsOrigin
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (parts.includes('*')) {
                errors.push(
                    'CORS_ORIGIN must not contain wildcard "*" member in production (e.g. "https://a.example,*" is forbidden).'
                );
            }
            // Also reject origins that look like wildcard patterns.
            for (const p of parts) {
                if (p.includes('*')) {
                    errors.push(
                        `CORS_ORIGIN member "${p}" contains wildcard; only exact origins are allowed in production.`
                    );
                    break;
                }
            }
        }
    } else {
        // Non-production: disabled auth still requires deliberate acknowledgement
        // when binding on a non-loopback host.
        if (
            cfg.authMode === 'disabled' &&
            !cfg.allowInsecureAdmin &&
            cfg.host !== 'localhost' &&
            cfg.host !== '127.0.0.1' &&
            cfg.host !== '::1'
        ) {
            errors.push(
                'AUTH_MODE=disabled on a non-loopback host requires ALLOW_INSECURE_ADMIN=true. ' +
                    'This acknowledges that anyone who can reach the service can administer it.'
            );
        }
    }

    // Always: if static-token mode, token must exist.
    if (cfg.authMode === 'static-token' && !cfg.adminToken) {
        errors.push('AUTH_MODE=static-token requires ADMIN_TOKEN.');
    }
    if (cfg.authMode === 'service-jwt' && !cfg.serviceJwtSecret) {
        errors.push('AUTH_MODE=service-jwt requires SERVICE_JWT_SECRET.');
    }

    if (errors.length) {
        throw new Error(
            'Unsafe configuration — refusing to start:\n  • ' +
                errors.join('\n  • ')
        );
    }
}

/** Resolve the public base URL used to build absolute proxy / grant URLs. */
export function resolvePublicUrl(cfg: AppConfig): string {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, '');
    const needsPort = !(cfg.port === 80 || cfg.port === 443);
    return needsPort ? `http://${cfg.host}:${cfg.port}` : `http://${cfg.host}`;
}
