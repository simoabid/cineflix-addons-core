import 'dotenv/config';

/**
 * Centralised environment configuration for addons-core.
 *
 * Everything the server needs is read once here so the rest of the codebase
 * stays free of scattered `process.env` reads.
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

    store: 'file' | 'redis';
    dataFile: string;
    seedUrls: string[];

    adminEnabled: boolean;
    adminToken?: string;

    enableNativeAddon: boolean;

    /** Debrid via env (takes precedence over persisted settings). */
    debridProvider: string;
    debridApiKey: string;

    /** Background health/refresh. */
    healthIntervalMinutes: number;
    autoRefresh: boolean;
}

export function loadConfig(): AppConfig {
    const port = envNum('PORT', 3006);
    const host = envStr('HOST', 'localhost');
    const publicUrl = envStr('PUBLIC_URL') || undefined;

    return {
        name: 'AddonsCore',
        version: '1.0.0',
        host,
        port,
        publicUrl,
        corsOrigin: envStr('CORS_ORIGIN', '*'),
        nodeEnv: envStr('NODE_ENV', 'development'),
        internalDebug: envBool('INTERNAL_DEBUG', false),

        tmdbApiKey: envStr('TMDB_API_KEY'),
        tmdbCacheTTL: envNum('TMDB_CACHE_TTL', 86400),

        cacheType:
            envStr('CACHE_TYPE', 'memory') === 'redis' ? 'redis' : 'memory',
        redis: {
            host: envStr('REDIS_HOST', 'localhost'),
            port: envNum('REDIS_PORT', 6379),
            password: envStr('REDIS_PASSWORD') || undefined
        },

        store: envStr('ADDONS_STORE', 'file') === 'redis' ? 'redis' : 'file',
        dataFile: envStr('ADDONS_DATA_FILE', './data/addons.json'),
        seedUrls: envList('ADDONS_SEED_URLS'),

        adminEnabled: envBool('ADMIN_ENABLED', true),
        adminToken: envStr('ADMIN_TOKEN') || undefined,

        enableNativeAddon: envBool('STREMIO_ADDON', false),

        debridProvider: envStr('DEBRID_PROVIDER', 'none'),
        debridApiKey: envStr('DEBRID_API_KEY'),

        healthIntervalMinutes: envNum('ADDON_HEALTH_INTERVAL_MINUTES', 15),
        autoRefresh: envBool('ADDON_AUTO_REFRESH', false)
    };
}

/** Resolve the public base URL used to build absolute proxy URLs. */
export function resolvePublicUrl(cfg: AppConfig): string {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, '');
    const needsPort = !(cfg.port === 80 || cfg.port === 443);
    return needsPort ? `http://${cfg.host}:${cfg.port}` : `http://${cfg.host}`;
}
