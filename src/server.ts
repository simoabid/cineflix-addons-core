import { OMSSServer } from '@omss/framework';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
    loadConfig,
    resolvePublicUrl,
    assertProductionSafe
} from './config.js';
import { AddonManager } from './addons/manager.js';
import {
    buildProgressiveMedia,
    listProvidersWithPriority,
    scrapeSingleProvider
} from './progressiveScrape.js';
import { aggregateSubtitles } from './subtitles/index.js';
import { HealthMonitor } from './health/monitor.js';
import { registerAddonRoutes } from './routes/addons.routes.js';
import { registerImportRoutes } from './routes/import.routes.js';
import { registerAuthRoutes } from './routes/auth.js';
import { logScrapeProxyStatus } from './egress/scrapeFetch.js';
import { installStreamEgress } from './egress/globalDispatcher.js';
import {
    assertCorsSafe,
    registerHttpSecurity,
    applySecurityHeaders,
    createAuditLogger,
    createSecureProxyContext,
    registerSecureProxyRoutes,
    toSafeError
} from './security/index.js';
import {
    createRateLimiter as createScrapeRateLimiter,
    RATE_LIMITS as SCRAPE_RATE_LIMITS,
    rateLimitKey as scrapeRateLimitKey
} from './security/rateLimit.js';
import { getRateLimitIp } from './security/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMIN_DIR = path.join(__dirname, '..', 'public', 'admin');

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

async function main(): Promise<void> {
    const cfg = loadConfig();

    if (!cfg.tmdbApiKey) {
        console.error(
            '\n[fatal] TMDB_API_KEY is required (used to resolve IMDb ids for Stremio addons).\n' +
                '        Set it in .env — see .env.example.\n'
        );
        process.exit(1);
    }

    // Fail closed on unsafe production (and some non-prod) combinations.
    try {
        assertProductionSafe(cfg);
        assertCorsSafe(cfg);
    } catch (err) {
        console.error(
            '\n[fatal] ' +
                (err instanceof Error ? err.message : String(err)) +
                '\n'
        );
        process.exit(1);
    }

    // Effective secure-proxy flag: on by default; legacy only when explicitly allowed.
    if (cfg.allowLegacyProxy && cfg.nodeEnv === 'production') {
        console.error(
            '\n[fatal] ALLOW_LEGACY_PROXY is forbidden in production.\n'
        );
        process.exit(1);
    }

    installStreamEgress();

    const publicUrl = resolvePublicUrl(cfg);
    const audit = createAuditLogger({
        filePath: cfg.auditLogFile,
        enabled: cfg.auditEnabled
    });

    const corsOrigin = cfg.corsOrigin.includes(',')
        ? cfg.corsOrigin
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : cfg.corsOrigin;

    const server = new OMSSServer({
        name: cfg.name,
        version: cfg.version,
        host: cfg.host,
        port: cfg.port,
        publicUrl: cfg.publicUrl,
        cache: {
            type: cfg.cacheType,
            ttl: { sources: 60 * 60, subtitles: 60 * 60 * 24 },
            redis: {
                host: cfg.redis.host,
                port: cfg.redis.port,
                password: cfg.redis.password
            }
        },
        tmdb: { apiKey: cfg.tmdbApiKey, cacheTTL: cfg.tmdbCacheTTL },
        proxyConfig: {
            knownThirdPartyProxies: {},
            streamPatterns: [/\.ts(\?|$)/i, /\.m4s(\?|$)/i]
        },
        cors: {
            origin: corsOrigin,
            methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
            allowedHeaders: [
                'Content-Type',
                'Authorization',
                'x-admin-token',
                'x-request-id',
                'x-forwarded-user',
                'x-forwarded-role',
                'x-csrf-token',
                'X-CSRF-Token'
            ],
            exposedHeaders: [
                'Content-Range',
                'Accept-Ranges',
                'ETag',
                'X-Request-Id',
                'X-RateLimit-Limit',
                'X-RateLimit-Remaining',
                'Retry-After'
            ],
            optionsSuccessStatus: 204
        },
        stremio: {
            enableNativeAddon: cfg.enableNativeAddon,
            stremioAddons: []
        },
        mcp: { enabled: false }
    });

    const registry = server.getRegistry();
    const manager = AddonManager.create(registry, cfg);
    await manager.init();

    const proxyCtx = createSecureProxyContext(cfg);
    // Wire grants into providers so sources use /v1/proxy/grant/:id.
    if (cfg.secureProxy) {
        manager.setPlaybackGrants(proxyCtx.grants, publicUrl);
    }

    const monitor = new HealthMonitor(manager, {
        intervalMinutes: cfg.healthIntervalMinutes,
        autoRefresh: cfg.autoRefresh
    });

    const app = server.getInstance();

    // Redact raw request URLs for the framework logger (P1): grant/token URLs contain bearer tokens
    // Mutate request.url before the logger's finish handler captures it; restore after.
    const origUrls = new WeakMap<import('fastify').FastifyRequest, string>();
    app.addHook('onRequest', async (request) => {
        const url = request.url ?? '';
        if (
            url.startsWith('/v1/proxy/grant/') ||
            url.startsWith('/v1/proxy/token/')
        ) {
            origUrls.set(request, url);
            const redacted = url.startsWith('/v1/proxy/grant/')
                ? '/v1/proxy/grant/[REDACTED]'
                : '/v1/proxy/token/[REDACTED]';
            // Fastify's request.url is mutable via raw
            (request as unknown as { url: string }).url = redacted;
            if ((request as unknown as { raw: { url?: string } }).raw) {
                (request as unknown as { raw: { url: string } }).raw.url =
                    redacted;
            }
        }
    });
    app.addHook('onResponse', async (request) => {
        const orig = origUrls.get(request);
        if (orig) {
            (request as unknown as { url: string }).url = orig;
            if ((request as unknown as { raw: { url?: string } }).raw) {
                (request as unknown as { raw: { url: string } }).raw.url = orig;
            }
        }
    });
    // The above hooks ensure grant URLs are redacted before the framework logger reads them.

    // Global HTTP security (headers, cookies, safe errors, query length).
    registerHttpSecurity(app, cfg);

    // Secure playback grant routes + legacy open-proxy block.
    registerSecureProxyRoutes(app, cfg, proxyCtx, publicUrl);

    // ── Auth session endpoints ────────────────────────────────────────────────
    registerAuthRoutes(app, cfg, audit);

    // ── Provider list (frontend waterfall order) ──────────────────────────────
    app.get('/v1/providers', async (_req, reply) => {
        return reply.code(200).send(listProvidersWithPriority(manager));
    });

    // ── Progressive single-addon scrape ───────────────────────────────────────
    const scrapeLimiter = {
        lim: createScrapeRateLimiter(),
        RATE_LIMITS: SCRAPE_RATE_LIMITS,
        rateLimitKey: scrapeRateLimitKey
    };
    async function checkScrapeRateLimit(
        request: import('fastify').FastifyRequest,
        reply: import('fastify').FastifyReply
    ): Promise<boolean> {
        const ip = getRateLimitIp(request, cfg);
        const key = scrapeLimiter.rateLimitKey(
            'scrape' as string,
            undefined,
            ip
        );
        // Use a dedicated bucket for progressive scraping: 30/min per IP, concurrency via limiter
        const res = scrapeLimiter.lim.take(key, 30, 60_000);
        reply.header('X-RateLimit-Limit', String(res.limit));
        reply.header('X-RateLimit-Remaining', String(res.remaining));
        if (!res.allowed) {
            reply.header('Retry-After', String(res.retryAfterSec));
            await reply.code(429).send({
                error: {
                    code: 'RATE_LIMITED',
                    message: 'Too many scraping requests'
                }
            });
            return false;
        }
        return true;
    }

    app.get<{ Params: { tmdbId: string; providerId: string } }>(
        '/v1/movies/:tmdbId/providers/:providerId',
        async (request, reply) => {
            if (!(await checkScrapeRateLimit(request, reply))) return;
            const { tmdbId, providerId } = request.params;
            try {
                const media = await buildProgressiveMedia('movie', tmdbId);
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media,
                    manager.getTimeoutMs(providerId)
                );
                return reply.code(200).send(result);
            } catch (err) {
                return sendProviderError(reply, err);
            }
        }
    );

    app.get<{
        Params: {
            tmdbId: string;
            season: string;
            episode: string;
            providerId: string;
        };
    }>(
        '/v1/tv/:tmdbId/seasons/:season/episodes/:episode/providers/:providerId',
        async (request, reply) => {
            if (!(await checkScrapeRateLimit(request, reply))) return;
            const { tmdbId, season, episode, providerId } = request.params;
            const s = Number(season);
            const e = Number(episode);
            if (!Number.isFinite(s) || !Number.isFinite(e)) {
                return reply.code(400).send({
                    sources: [],
                    subtitles: [],
                    diagnostics: [],
                    error: 'Invalid season or episode'
                });
            }
            try {
                const media = await buildProgressiveMedia('tv', tmdbId, s, e);
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media,
                    manager.getTimeoutMs(providerId)
                );
                return reply.code(200).send(result);
            } catch (err) {
                return sendProviderError(reply, err);
            }
        }
    );

    // ── Dedicated subtitle aggregation ─────────────────────────────────────────
    app.get<{
        Querystring: {
            tmdbId?: string;
            imdbId?: string;
            id?: string;
            season?: string;
            episode?: string;
            s?: string;
            e?: string;
            language?: string;
        };
    }>('/v1/subtitles', async (request, reply) => {
        if (!(await checkScrapeRateLimit(request, reply))) return;
        const q = request.query;
        const id = (q.id || '').trim();
        const imdbId = (q.imdbId || (id.startsWith('tt') ? id : '')).trim();
        const tmdbId = (
            q.tmdbId || (!imdbId && /^\d+$/.test(id) ? id : '')
        ).trim();
        const seasonRaw = q.season ?? q.s;
        const episodeRaw = q.episode ?? q.e;
        const season =
            seasonRaw != null && seasonRaw !== ''
                ? Number(seasonRaw)
                : undefined;
        const episode =
            episodeRaw != null && episodeRaw !== ''
                ? Number(episodeRaw)
                : undefined;

        if (!imdbId && !tmdbId) {
            return reply.code(400).send({
                subtitles: [],
                error: 'Provide tmdbId, imdbId, or id'
            });
        }

        const result = await aggregateSubtitles(
            manager,
            publicUrl,
            {
                imdbId: imdbId || undefined,
                tmdbId: tmdbId || undefined,
                season: Number.isFinite(season as number) ? season : undefined,
                episode: Number.isFinite(episode as number)
                    ? episode
                    : undefined,
                language: q.language
            },
            {
                grants: cfg.secureProxy ? proxyCtx.grants : undefined,
                secureProxy: cfg.secureProxy
            }
        );
        return reply.code(200).send({
            subtitles: result.subtitles,
            source: 'stremio-addons',
            addonsQueried: result.addonsQueried,
            ...(result.error ? { error: result.error } : {})
        });
    });

    // ── Management + import API ────────────────────────────────────────────────
    registerAddonRoutes(app, manager, cfg, monitor, audit);
    registerImportRoutes(app, manager, cfg, audit);

    // ── Admin UI (static) ──────────────────────────────────────────────────────
    if (cfg.adminEnabled) {
        registerAdminUi(app, cfg);
    }

    await server.start();

    logScrapeProxyStatus();
    monitor.start();

    const authSummary =
        cfg.authMode === 'disabled'
            ? 'AUTH_MODE=disabled (local only)'
            : `AUTH_MODE=${cfg.authMode}`;
    console.log(
        `\n[addons-core] ready → ${publicUrl}` +
            `\n  • ${authSummary}` +
            `\n  • secureProxy=${cfg.secureProxy} legacyProxy=${cfg.allowLegacyProxy}` +
            `\n  • Point CINEFLIX serverUrl / VITE_CINEPRO_URL at this base.` +
            (cfg.adminEnabled ? `\n  • Admin UI: ${publicUrl}/admin` : '') +
            `\n  • Store: ${manager.describeStore()}\n`
    );
}

function sendProviderError(
    reply: import('fastify').FastifyReply,
    err: unknown
) {
    const status = (err as Error & { statusCode?: number }).statusCode ?? 500;
    const safe = toSafeError(err, status);
    const message = safe.body.error.message;
    return reply.code(safe.status).send({
        sources: [],
        subtitles: [],
        diagnostics: [
            {
                code: safe.body.error.code,
                message,
                field: '',
                severity: 'error'
            }
        ],
        error: message
    });
}

function registerAdminUi(
    app: import('fastify').FastifyInstance,
    cfg: import('./config.js').AppConfig
): void {
    const serveFile = async (
        relPath: string,
        reply: import('fastify').FastifyReply
    ): Promise<void> => {
        const safe = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const full = path.join(ADMIN_DIR, safe);
        if (!full.startsWith(ADMIN_DIR)) {
            await reply.code(403).send({ error: 'Forbidden' });
            return;
        }
        try {
            const data = await fs.readFile(full);
            const ext = path.extname(full).toLowerCase();
            applySecurityHeaders(reply, cfg, { adminUi: true });
            await reply
                .header(
                    'Content-Type',
                    CONTENT_TYPES[ext] ?? 'application/octet-stream'
                )
                .code(200)
                .send(data);
        } catch {
            await reply.code(404).send({ error: 'Not found' });
        }
    };

    app.get('/admin', async (_req, reply) => serveFile('index.html', reply));
    app.get<{ Params: { '*': string } }>('/admin/*', async (req, reply) => {
        const rest = req.params['*'] || 'index.html';
        return serveFile(rest, reply);
    });
}

main().catch((err) => {
    console.error('[addons-core] fatal:', err);
    process.exit(1);
});
