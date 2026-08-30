import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { OMSSServer } from '@omss/framework';
import { nanoid } from 'nanoid';
import {
    loadConfig,
    resolvePublicUrl,
    assertProductionSafe,
    type AppConfig
} from './config.js';
import { AddonManager, toPublicAddon } from './addons/manager.js';
import { redactString } from './security/redaction.js';
import {
    buildProgressiveMedia,
    listProvidersWithPriority,
    scrapeSingleProvider
} from './progressiveScrape.js';
import { aggregateSubtitles } from './subtitles/index.js';
import { HealthMonitor } from './health/monitor.js';
import { ProviderSelectionService } from './providers/selection.js';
import { globalReliability } from './reliability/circuit.js';
import {
    getTmdbApiBaseUrl,
    globalMediaIdentity,
    setTmdbApiBaseUrl
} from './media/mediaIdentity.js';
import { makeAuthGuard, registerAuthRoutes } from './routes/auth.js';
import { normalizeUpstreamUrl } from './sources/normalization.js';
import { registerAddonRoutes } from './routes/addons.routes.js';
import { registerImportRoutes } from './routes/import.routes.js';
import { registerJobRoutes } from './routes/jobs.routes.js';
import { createStorageBackend } from './storage/index.js';
import { migrateLegacyFileToStorage } from './storage/importer.js';
import { CacheManager } from './cache/index.js';
import { buildAggregateResultKey } from './cache/namespaces.js';
import { JobEngine } from './jobs/index.js';
import { debridService } from './debrid/service.js';
import { logScrapeProxyStatus, closeEgress } from './egress/scrapeFetch.js';
import { installStreamEgress } from './egress/globalDispatcher.js';
import {
    assertCorsSafe,
    registerHttpSecurity,
    applySecurityHeaders,
    createAuditLogger,
    createSecureProxyContext,
    createProxyCapacityGuards,
    registerSecureProxyRoutes,
    toSafeError
} from './security/index.js';
import {
    createRateLimiter as createScrapeRateLimiter,
    RATE_LIMITS as SCRAPE_RATE_LIMITS,
    rateLimitKey as scrapeRateLimitKey
} from './security/rateLimit.js';
import { getRateLimitIp } from './security/auth.js';
import { registerOpenApiRoutes } from './routes/openapi.routes.js';
import { globalMetrics } from './metrics/index.js';
import {
    logger,
    configureLogger,
    tracer,
    globalTraceRecorder,
    type Span
} from './telemetry/index.js';
import {
    subtitlesQueryValidator,
    tmdbIdValidator,
    providerIdValidator,
    seasonEpisodeValidator
} from './validation/schemas.js';
import { formatValidationError } from './validation/validator.js';
import { globalConcurrency } from './concurrency/coordinator.js';
import {
    globalReadinessGate,
    ShutdownCoordinator
} from './lifecycle/shutdown.js';
import { ClusterBus } from './cluster/bus.js';
import { globalProviderBudgets } from './capacity/budgets.js';

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

    configureLogger({
        level: cfg.logLevel,
        format: cfg.logFormat,
        serviceName: cfg.name,
        serviceVersion: cfg.version
    });
    tracer.setEnabled(cfg.tracingEnabled);

    if (!cfg.tmdbApiKey) {
        console.error(
            '\n[fatal] TMDB_API_KEY is required (used to resolve IMDb ids for Stremio addons).\n' +
                '        Set it in .env — see .env.example.\n'
        );
        process.exit(1);
    }

    // Route media-identity resolution at the configured TMDB origin
    // (self-hosted mirror / hermetic e2e override).
    setTmdbApiBaseUrl(cfg.tmdbApiBaseUrl);

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

    // ── Phase 7: configure global resilience/capacity singletons ──────────
    const instanceId = `inst_${process.pid}_${nanoid(6)}`;
    globalConcurrency.configure(cfg);
    globalReliability.configureQuarantine({
        enabled: cfg.quarantineEnabled,
        openThreshold: cfg.quarantineOpenThreshold,
        windowMs: cfg.quarantineWindowMs,
        ttlMs: cfg.quarantineTtlMs
    });
    globalReliability.configureConcurrency(cfg.concurrency.providerStream);
    globalProviderBudgets.configure({
        defaultDailyLimit: cfg.providerDailyCallBudget,
        overrides: cfg.providerBudgetOverrides
    });

    const publicUrl = resolvePublicUrl(cfg);
    const audit = createAuditLogger({
        filePath: cfg.auditLogFile,
        enabled: cfg.auditEnabled
    });
    debridService.setAuditLogger(audit);

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

    const storage = createStorageBackend(cfg);
    await storage.init();

    // If storage is newly initialized and a legacy JSON file exists, migrate it
    const existingAddons = await storage.listAddons();
    if (existingAddons.length === 0) {
        try {
            const stats = await fs.stat(cfg.dataFile);
            if (stats.isFile()) {
                const migRes = await migrateLegacyFileToStorage(
                    cfg.dataFile,
                    storage,
                    { backup: true }
                );
                if (migRes.migrated > 0) {
                    console.log(
                        `[storage] Migrated ${migRes.migrated} legacy addon(s) to ${storage.describe()}`
                    );
                }
            }
        } catch {
            /* ignore ENOENT */
        }
    }

    const cacheManager = new CacheManager(cfg, {
        aggregateResultSec: cfg.cacheTtlSources,
        aggregateSwrSec: cfg.cacheSwrSec
    });

    // ── Phase 7 §10.3: cluster event bus (Redis pub/sub; no-op single-node) ─
    const useSharedRedis = cfg.cacheType === 'redis' || cfg.store === 'redis';
    const clusterBus = new ClusterBus({
        enabled: cfg.clusterBusEnabled,
        instanceId,
        redis: useSharedRedis ? cfg.redis : undefined
    });
    await clusterBus.start();

    const registry = server.getRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    // Revision hook: clear bulk/OMSS cache when provider set changes so
    // disabled/removed addons never remain in cached responses.
    // Made revision-aware: cache keys include provider revision, so stale entries
    // are never hit even if clear is async. Hook still clears for memory hygiene.
    const omssCache = (
        server as unknown as { cache: { clear(): Promise<void> } }
    ).cache;
    manager.setRevisionHook(async (rev) => {
        try {
            await cacheManager.invalidateOnRevisionChange(rev);
            await omssCache.clear();
            console.log(`[cache] cleared after revision ${rev}`);
        } catch {
            /* ignore */
        }
        try {
            globalMediaIdentity.clearCache();
        } catch {
            /* ignore */
        }
        // Tell other replicas to reload from shared storage (§10.3).
        await clusterBus.publish({
            type: 'revision',
            revision: rev,
            origin: instanceId
        });
        // Best-effort cache-invalidate for memory-only fallback nodes where
        // Redis invalidation may have missed or raced; remote handler will
        // drop its in-memory prefix copies. Harmless duplicate when Redis
        // already cleared.
        await clusterBus
            .publish({
                type: 'cache-invalidate',
                prefixes: ['aggregate-result:v1:', 'provider-result:v1:'],
                origin: instanceId
            })
            .catch(() => undefined);
    });
    // Cross-instance sync: a replica that mutated the provider set bumps the
    // shared revision; reload local state and drop caches when we're behind.
    clusterBus.on(async (event) => {
        if (event.type === 'revision') {
            if (event.revision > manager.getRevision()) {
                logger.info(
                    `Cluster revision ${event.revision} > local ${manager.getRevision()} — reloading`,
                    { component: 'cluster', origin: event.origin }
                );
                const reloaded = await manager.reloadFromStorage(
                    `cluster-revision-${event.revision}`
                );
                if (reloaded) {
                    try {
                        await cacheManager.invalidateOnRevisionChange(
                            event.revision
                        );
                        await omssCache.clear();
                        globalMediaIdentity.clearCache();
                    } catch {
                        /* ignore */
                    }
                }
            }
        } else if (event.type === 'cache-invalidate') {
            for (const prefix of event.prefixes) {
                await cacheManager
                    .invalidatePrefix(prefix)
                    .catch(() => undefined);
            }
        }
    });
    await manager.init();

    const jobEngine = new JobEngine(storage, manager, cfg, {
        concurrency: cfg.jobWorkerConcurrency,
        pollIntervalMs: cfg.jobPollIntervalMs
    });

    const proxyCtx = createSecureProxyContext(cfg);
    // Phase 7 §10.4 — capacity guards shared by proxy routes, health, metrics.
    const capacityGuards = createProxyCapacityGuards(cfg);
    const proxyCtxWithCapacity = {
        ...proxyCtx,
        streams: capacityGuards.streams,
        egress: capacityGuards.egress,
        maxGrantsPerRequest: capacityGuards.maxGrantsPerRequest
    };
    // Wire grants into providers so sources use /v1/proxy/grant/:id.
    if (cfg.secureProxy) {
        manager.setPlaybackGrants(proxyCtx.grants, publicUrl);
    }

    // Make bulk + native Stremio use the unified MediaIdentityService (single TMDB path, §5.4).
    // Framework's separate TMDBService is patched to delegate to globalMediaIdentity so
    // progressive, bulk, subtitles, and native routes share one cache/taxonomy.
    patchTMDBService(server);

    // Authoritative provider selection — single source of truth for ordering.
    // Budgets (Phase 7 §10.4) filter providers with exhausted daily call limits.
    const selection = new ProviderSelectionService(
        manager,
        globalReliability,
        globalProviderBudgets
    );

    // Make source cache keys revision-aware so stale entries are never hit after a mutation,
    // even if the async clear hasn't finished. Also injects creation revision into cached responses.
    patchCacheRevision(server, selection, cacheManager, cfg);

    // Patch OMSS SourceService to use selection ordering and bounded concurrency.
    // This makes bulk and progressive agree on priority and ensures
    // reordering changes both paths predictably (Phase 2.2 acceptance).
    patchSourceService(server, selection, cfg);

    const monitor = new HealthMonitor(manager, {
        intervalMinutes: cfg.healthIntervalMinutes,
        autoRefresh: cfg.autoRefresh,
        jobEngine,
        staleThresholdMinutes: cfg.healthStaleThresholdMinutes,
        degradedMinProvidersRatio: cfg.healthDegradedMinProvidersRatio,
        version: cfg.version,
        readinessGate: globalReadinessGate,
        capacity: {
            providerBudgets: globalProviderBudgets,
            egress: capacityGuards.egress,
            streams: capacityGuards.streams
        },
        cluster: clusterBus
    });

    const app = server.getInstance();

    // Redact raw request URLs for the framework logger (P1): grant/token URLs contain bearer tokens
    // Mutate request.raw.url before the logger's finish handler captures it;
    // restore after. Fastify's request.url getter delegates to raw.url, so
    // writing raw.url is the single source of truth (request.url itself is
    // getter-only in current Fastify and must not be assigned directly).
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
            const raw = (request as unknown as { raw?: { url?: string } }).raw;
            if (raw) {
                raw.url = redacted;
            }
        }
    });
    app.addHook('onResponse', async (request) => {
        const orig = origUrls.get(request);
        if (orig) {
            const raw = (request as unknown as { raw?: { url?: string } }).raw;
            if (raw) {
                raw.url = orig;
            }
        }
    });
    // The above hooks ensure grant URLs are redacted before the framework logger reads them.

    // Every bulk/refresh response should carry the provider revision for debugging (Phase 2.2).
    app.addHook('onSend', async (request, reply, payload) => {
        const url = request.url ?? '';
        if (
            url.startsWith('/v1/movies/') ||
            url.startsWith('/v1/tv/') ||
            url.startsWith('/v1/providers') ||
            url.startsWith('/v1/subtitles')
        ) {
            reply.header('x-provider-revision', String(manager.getRevision()));
            // For JSON payloads, also inject `revision` field when possible
            if (typeof payload === 'string' && payload.startsWith('{')) {
                try {
                    const body = JSON.parse(payload);
                    if (
                        body &&
                        typeof body === 'object' &&
                        !Array.isArray(body) &&
                        body.revision == null
                    ) {
                        body.revision = manager.getRevision();
                        return JSON.stringify(body);
                    }
                } catch {
                    /* ignore */
                }
            }
        }
        return payload;
    });

    // Global HTTP security (headers, cookies, safe errors, query length).
    registerHttpSecurity(app, cfg);

    // Phase 7 §10.2 — once shutdown begins, refuse new work with 503 so the
    // load balancer drains us; probes and metrics stay served.
    app.addHook('onRequest', async (request, reply) => {
        if (!globalReadinessGate.isShuttingDown) return;
        const path = (request.url ?? '').split('?')[0];
        if (
            path.startsWith('/health') ||
            path === '/metrics' ||
            path === '/health/ready' ||
            path === '/health/live'
        ) {
            reply.header('Connection', 'close');
            return;
        }
        reply.header('Connection', 'close');
        reply.header('Retry-After', '5');
        await reply.code(503).send({
            error: {
                code: 'SHUTTING_DOWN',
                message: 'Instance is shutting down — retry another replica'
            },
            requestId: request.id
        });
    });

    // Secure playback grant routes + legacy open-proxy block.
    registerSecureProxyRoutes(app, cfg, proxyCtxWithCapacity, publicUrl);

    // ── Auth session endpoints ────────────────────────────────────────────────
    registerAuthRoutes(app, cfg, audit);

    // ── Provider list (frontend waterfall order) ──────────────────────────────
    // Exposes capability metadata and revision (Phase 2.1/2.2).
    // Returns array for back-compat; also sets X-Provider-Revision header.
    // Detailed meta available at /v1/providers/meta
    app.get('/v1/providers', async (_req, reply) => {
        const list = listProvidersWithPriority(manager, selection);
        reply.header('x-provider-revision', String(manager.getRevision()));
        // Return array directly (OMSS convention) — clients that need counts can call /v1/providers/meta
        return reply.code(200).send(list);
    });

    app.get('/v1/providers/meta', async (_req, reply) => {
        const list = listProvidersWithPriority(manager, selection);
        return reply.code(200).send({
            providers: list,
            revision: manager.getRevision(),
            counts: {
                total: manager.list().length,
                stream: manager.getStreamEnabled().length,
                subtitles: manager.getSubtitleEnabled().length,
                catalogOnly: manager
                    .list()
                    .filter((a) => a.capabilities?.status === 'limited').length,
                unsupported: manager
                    .list()
                    .filter((a) => a.capabilities?.status === 'unsupported')
                    .length
            }
        });
    });

    // Diagnostics endpoint: per-provider circuit/metrics (privileged — admin/operator only)
    const diagGuard = makeAuthGuard(cfg, { role: 'viewer' });
    app.get(
        '/v1/providers/diagnostics',
        { preHandler: diagGuard },
        async (_req, reply) => {
            return reply.code(200).send({
                revision: manager.getRevision(),
                reliability: globalReliability.snapshot(),
                quarantined: globalReliability.listQuarantined(),
                providerBudgets: globalProviderBudgets.snapshot(),
                providers: manager.list().map((a) => ({
                    id: a.providerId,
                    name: a.name,
                    enabled: a.enabled,
                    capabilities: a.capabilities,
                    state: globalReliability.getState(a.providerId),
                    quarantined: globalReliability.isQuarantined(a.providerId),
                    budgetExhausted: globalProviderBudgets.isExhausted(
                        a.providerId
                    ),
                    metrics: globalReliability.getMetrics(a.providerId)
                }))
            });
        }
    );

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
        // Phase 7 §10.4 — dedicated bucket per IP with a tighter quota for
        // anonymous callers when one is configured (authenticated actors get
        // the standard scrape quota).
        const authUser = (request as unknown as { authUser?: { id?: string } })
            .authUser;
        const perMin = authUser?.id
            ? cfg.scrapeRateLimitPerMin
            : cfg.anonScrapeRateLimitPerMin || cfg.scrapeRateLimitPerMin;
        const res = scrapeLimiter.lim.take(key, perMin, 60_000);
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

    // Tracing & Structured Telemetry hooks (Phase 6.1 & 6.3)
    const requestSpans = new WeakMap<import('fastify').FastifyRequest, Span>();

    app.addHook('onRequest', async (request, reply) => {
        (request as unknown as { _reqStartTime?: number })._reqStartTime =
            Date.now();
        globalMetrics.incrementActiveRequests();

        const parentContext = tracer.extractTraceparent(request.headers);
        const span = tracer.startSpan('http.server.request', {
            parentContext,
            attributes: {
                'http.method': request.method,
                'http.route': request.url,
                'http.client_ip': request.ip
            }
        });
        requestSpans.set(request, span);

        reply.header('x-trace-id', span.traceId);
        reply.header('traceparent', `00-${span.traceId}-${span.spanId}-01`);
    });

    app.addHook('onResponse', async (request, reply) => {
        globalMetrics.decrementActiveRequests();
        const start = (request as unknown as { _reqStartTime?: number })
            ._reqStartTime;
        const duration = start ? Date.now() - start : 0;
        const responseBytes = Number(reply.getHeader('content-length')) || 0;

        globalMetrics.recordHttpRequest(
            request.method,
            request.url ?? '',
            reply.statusCode,
            duration,
            responseBytes
        );

        const span = requestSpans.get(request);
        if (span) {
            span.setAttribute('http.status_code', reply.statusCode);
            span.setStatus(reply.statusCode < 500 ? 'ok' : 'error');
            span.end();
        }

        const reqAuth = (
            request as unknown as {
                authUser?: { id?: string; role?: string };
            }
        ).authUser;
        const actorId = reqAuth?.id;
        const sanitizedUrl = request.url?.startsWith('/v1/proxy/')
            ? '/v1/proxy/[REDACTED]'
            : request.url;

        const hostHeader =
            (request.headers['x-forwarded-host'] as string) ||
            (request.headers.host as string) ||
            undefined;
        const upstreamHost = hostHeader ? hostHeader.split(':')[0] : undefined;
        const failureClassification =
            reply.statusCode >= 500
                ? 'http_5xx'
                : reply.statusCode >= 400
                  ? 'http_4xx'
                  : undefined;

        logger.info(
            `${request.method} ${sanitizedUrl} ${reply.statusCode} (${duration}ms)`,
            {
                requestId: request.id,
                traceId: span?.traceId,
                spanId: span?.spanId,
                actorId,
                route: sanitizedUrl,
                method: request.method,
                statusCode: reply.statusCode,
                durationMs: duration,
                upstreamHost,
                failureClassification
            }
        );
    });

    app.addHook('onError', async (request, _reply, error) => {
        const span = requestSpans.get(request);
        if (span) {
            span.recordException(error);
        }
        const hostHeader =
            (request.headers['x-forwarded-host'] as string) ||
            (request.headers.host as string) ||
            undefined;
        const upstreamHost = hostHeader ? hostHeader.split(':')[0] : undefined;
        logger.error(error, {
            requestId: request.id,
            traceId: span?.traceId,
            spanId: span?.spanId,
            route: request.url,
            method: request.method,
            upstreamHost,
            failureClassification: 'http_5xx'
        });
    });

    app.get<{ Params: { tmdbId: string; providerId: string } }>(
        '/v1/movies/:tmdbId/providers/:providerId',
        async (request, reply) => {
            if (!(await checkScrapeRateLimit(request, reply))) return;
            const { tmdbId, providerId } = request.params;
            const tRes = tmdbIdValidator(tmdbId);
            if (!tRes.ok && tRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(tRes.errors, request.id));
            }
            const pRes = providerIdValidator(providerId);
            if (!pRes.ok && pRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(pRes.errors, request.id));
            }

            // Unified media identity with validation + deadline (Phase 2.4)
            const deadline =
                Date.now() + manager.getTimeoutMs(providerId) + 12_000;
            try {
                const media = await buildProgressiveMedia(
                    'movie',
                    tmdbId,
                    undefined,
                    undefined,
                    {
                        deadlineMs: deadline,
                        signal: (request as unknown as { signal?: AbortSignal })
                            .signal
                    }
                );
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media,
                    manager.getTimeoutMs(providerId),
                    {
                        selection,
                        signal: (request as unknown as { signal?: AbortSignal })
                            .signal,
                        deadlineMs: deadline
                    }
                );
                // Use creation revision captured in result, not current (prevents stale labeling)
                return reply.code(200).send({
                    ...result,
                    revision: result.revision ?? manager.getRevision()
                });
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
            const tRes = tmdbIdValidator(tmdbId);
            if (!tRes.ok && tRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(tRes.errors, request.id));
            }
            const seRes = seasonEpisodeValidator(season, episode);
            if (!seRes.ok && seRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(seRes.errors, request.id));
            }
            const pRes = providerIdValidator(providerId);
            if (!pRes.ok && pRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(pRes.errors, request.id));
            }

            const s = seRes.data!.season;
            const e = seRes.data!.episode;
            const deadline =
                Date.now() + manager.getTimeoutMs(providerId) + 12_000;
            try {
                const media = await buildProgressiveMedia('tv', tmdbId, s, e, {
                    deadlineMs: deadline,
                    signal: (request as unknown as { signal?: AbortSignal })
                        .signal
                });
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media,
                    manager.getTimeoutMs(providerId),
                    {
                        selection,
                        signal: (request as unknown as { signal?: AbortSignal })
                            .signal,
                        deadlineMs: deadline
                    }
                );
                return reply.code(200).send({
                    ...result,
                    revision: result.revision ?? manager.getRevision()
                });
            } catch (err) {
                return sendProviderError(reply, err);
            }
        }
    );

    // ── Dedicated subtitle aggregation ─────────────────────────────────────────
    app.get<{
        Querystring: Record<string, unknown>;
    }>('/v1/subtitles', async (request, reply) => {
        if (!(await checkScrapeRateLimit(request, reply))) return;
        const valRes = subtitlesQueryValidator(request.query);
        if (!valRes.ok && valRes.errors) {
            return reply
                .code(400)
                .send(formatValidationError(valRes.errors, request.id));
        }
        const q = valRes.data!;

        const creationRev = manager.getRevision();
        const deadline = Date.now() + 15_000;
        try {
            const result = await aggregateSubtitles(
                manager,
                publicUrl,
                {
                    imdbId: q.imdbId,
                    tmdbId: q.tmdbId,
                    season: q.season,
                    episode: q.episode,
                    language: q.language
                },
                {
                    grants: cfg.secureProxy ? proxyCtx.grants : undefined,
                    secureProxy: cfg.secureProxy,
                    signal: (request as unknown as { signal?: AbortSignal })
                        .signal,
                    deadlineMs: deadline
                }
            );
            return reply.code(200).send({
                subtitles: result.subtitles,
                source: 'stremio-addons',
                addonsQueried: result.addonsQueried,
                revision: creationRev,
                ...(result.error ? { error: result.error } : {})
            });
        } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'SEMAPHORE_FULL' || code === 'QUEUE_TIMEOUT') {
                reply.header('Retry-After', '2');
                return reply.code(503).send({
                    subtitles: [],
                    source: 'stremio-addons',
                    addonsQueried: 0,
                    revision: creationRev,
                    diagnostics: [
                        {
                            code: 'OVERLOADED',
                            message:
                                err instanceof Error
                                    ? err.message
                                    : 'Concurrency pool saturated',
                            field: '',
                            severity: 'warning'
                        }
                    ],
                    error:
                        err instanceof Error
                            ? err.message
                            : 'Concurrency pool saturated'
                });
            }
            throw err;
        }
    });

    // ── Health Probes & Metrics (Phase 6.4) ───────────────────────────────────
    app.get('/health/live', async (_req, reply) => {
        const live = monitor.getLiveness();
        return reply.code(200).send(live);
    });

    app.get('/health/ready', async (_req, reply) => {
        const report = await monitor.getReadiness({
            storage,
            cache: cacheManager,
            jobEngine
        });
        const code = report.ready ? 200 : 503;
        return reply.code(code).send(report);
    });

    app.get('/health/status', async (_req, reply) => {
        const status = await monitor.getServiceStatus({
            storage,
            cache: cacheManager,
            jobEngine,
            tmdbKey: cfg.tmdbApiKey
        });
        const code = status.status === 'down' ? 503 : 200;
        return reply.code(code).send(status);
    });

    app.get('/health', async (_req, reply) => {
        const status = await monitor.getServiceStatus({
            storage,
            cache: cacheManager,
            jobEngine,
            tmdbKey: cfg.tmdbApiKey
        });
        const code = status.status === 'down' ? 503 : 200;
        return reply.code(code).send(status);
    });

    app.get('/health/dependencies', async (_req, reply) => {
        const deps = await monitor.getDependencies({
            storage,
            cache: cacheManager,
            jobEngine,
            tmdbKey: cfg.tmdbApiKey
        });
        const code = deps.status === 'down' ? 503 : 200;
        return reply.code(code).send(deps);
    });

    const metricsGuard = makeAuthGuard(cfg, { role: 'admin' });
    app.get<{ Querystring: { format?: string } }>(
        '/metrics',
        { preHandler: metricsGuard },
        async (req, reply) => {
            const format = req.query.format?.toLowerCase();
            const accept = req.headers.accept?.toLowerCase() ?? '';
            const wantsJson =
                format === 'json' || accept.includes('application/json');

            // Phase 7 live gauges (concurrency pools, capacity, readiness).
            const phase7Services = {
                concurrency: globalConcurrency,
                streams: capacityGuards.streams,
                egressBudget: capacityGuards.egress,
                grants: proxyCtx.grants,
                readiness: globalReadinessGate
            };

            if (wantsJson) {
                const snap = await globalMetrics.snapshot({
                    manager,
                    circuit: globalReliability,
                    cache: cacheManager,
                    jobs: jobEngine,
                    storage,
                    ...phase7Services
                });
                return reply
                    .header('Content-Type', 'application/json; charset=utf-8')
                    .code(200)
                    .send(snap);
            }

            const prom = await globalMetrics.toPrometheusText({
                manager,
                circuit: globalReliability,
                cache: cacheManager,
                jobs: jobEngine,
                storage,
                ...phase7Services
            });
            return reply
                .header(
                    'Content-Type',
                    'text/plain; version=0.0.4; charset=utf-8'
                )
                .code(200)
                .send(prom);
        }
    );

    // ── Protected Provider Debug Trace ────────────────────────────────────────
    const debugGuard = makeAuthGuard(cfg, { role: 'admin' });
    app.get<{ Params: { id: string } }>(
        '/debug/providers/:id',
        { preHandler: debugGuard },
        async (req, reply) => {
            const providerId = req.params.id;
            const addon = manager.get(providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Provider not found' },
                    requestId: req.id
                });
            }
            const pub = toPublicAddon(addon);
            const metrics = globalReliability.getMetrics(providerId);
            const state = globalReliability.getState(providerId);
            return reply.code(200).send({
                id: addon.providerId,
                name: addon.name,
                enabled: addon.enabled,
                admissionState:
                    addon.admissionState ??
                    (addon.enabled ? 'validated' : 'disabled'),
                order: addon.order,
                timeoutMs: addon.timeoutMs,
                source: addon.source,
                manifestUrl: pub.manifestUrl,
                baseUrl: pub.baseUrl,
                capabilities: pub.capabilities,
                validationFindings: addon.validationFindings?.map((f) => ({
                    ...f,
                    message: redactString(f.message)
                })),
                health: addon.health,
                reliability: {
                    state,
                    metrics,
                    quarantined: globalReliability.isQuarantined(providerId),
                    quarantine: globalReliability.getQuarantine(providerId)
                },
                revision: manager.getRevision(),
                addedAt: addon.addedAt,
                updatedAt: addon.updatedAt
            });
        }
    );

    // ── Protected Tracing Debug endpoint (Phase 6.3) ──────────────────────────
    app.get<{
        Querystring: {
            traceId?: string;
            hasError?: string;
            minDurationMs?: string;
            limit?: string;
        };
    }>('/debug/traces', { preHandler: debugGuard }, async (req, reply) => {
        const { traceId, hasError, minDurationMs, limit } = req.query;
        let spans = globalTraceRecorder.getRecent(Number(limit) || 100);

        if (traceId) {
            spans = globalTraceRecorder.findByTraceId(traceId);
        }
        if (hasError === 'true') {
            spans = spans.filter((s) => s.status === 'error');
        }
        if (minDurationMs) {
            const minMs = Number(minDurationMs);
            if (Number.isFinite(minMs)) {
                spans = spans.filter((s) => (s.durationMs ?? 0) >= minMs);
            }
        }

        return reply.code(200).send({
            total: spans.length,
            spans
        });
    });

    // ── OpenAPI & Interactive Docs ────────────────────────────────────────────
    registerOpenApiRoutes(app, cfg, publicUrl);

    // ── Management + import + job API ─────────────────────────────────────────
    registerAddonRoutes(
        app,
        manager,
        cfg,
        monitor,
        audit,
        storage,
        cacheManager,
        jobEngine
    );
    registerImportRoutes(app, manager, cfg, audit, jobEngine);
    registerJobRoutes(app, jobEngine, storage, cfg, audit);

    // ── Admin UI (static) ──────────────────────────────────────────────────────
    if (cfg.adminEnabled) {
        registerAdminUi(app, cfg);
    }

    await server.start();

    logScrapeProxyStatus();
    monitor.start();
    jobEngine.start();

    // ── Phase 7 §10.2: graceful shutdown / rolling deploys ──────────────────
    // Ordered phases: readiness already flipped by the coordinator before any
    // phase runs. Each phase is bounded; the whole sequence is bounded by the
    // configurable termination grace period. A second signal force-exits.
    const shutdown = new ShutdownCoordinator(globalReadinessGate, {
        gracePeriodMs: cfg.terminationGracePeriodMs,
        installSignals: true
    });
    shutdown
        .addPhase('stop-background-schedulers', async () => {
            monitor.stop();
        })
        .addPhase(
            'drain-jobs',
            async () => {
                if (cfg.shutdownDrainJobs) {
                    // Give in-flight jobs most of their share of the grace
                    // period, then release stragglers for retry elsewhere.
                    const drainMs = Math.max(
                        1000,
                        Math.floor(cfg.terminationGracePeriodMs * 0.6)
                    );
                    await jobEngine.beginShutdown(drainMs);
                } else {
                    jobEngine.stop();
                }
            },
            // Drain enforces its own deadline; this cap is the backstop.
            Math.max(2000, Math.floor(cfg.terminationGracePeriodMs * 0.7))
        )
        .addPhase('abort-queued-concurrency-waiters', async () => {
            const aborted = globalConcurrency.abortAllQueued();
            if (aborted > 0) {
                logger.info(`Aborted ${aborted} queued pool waiters`, {
                    component: 'lifecycle'
                });
            }
        })
        .addPhase('close-http-listener', async () => {
            // server.stop() closes the Fastify listener and waits for
            // in-flight requests to complete.
            await server.stop();
        })
        .addPhase('close-cluster-bus', async () => {
            await clusterBus.close();
        })
        .addPhase('close-cache', async () => {
            await cacheManager.close();
        })
        .addPhase('close-storage', async () => {
            await storage.close();
        })
        .addPhase('close-egress-agents', async () => {
            await closeEgress();
        });

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
            `\n  • Store: ${storage.describe()}\n`
    );
}

function patchTMDBService(server: OMSSServer): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tmdb = (server as unknown as { tmdbService: any }).tmdbService;
    if (!tmdb) return;
    // Route the framework's raw TMDB fetches (validateMovie/validateTVEpisode
    // before patching below) through the configured TMDB_API_BASE_URL so
    // mirrors and hermetic e2e tests work for the aggregate route too.
    tmdb.baseUrl = getTmdbApiBaseUrl();
    const origGetMedia = tmdb.getMediaObject.bind(tmdb);
    const origGetImdb = tmdb.getImdbId.bind(tmdb);
    // Bulk + native Stremio now share MediaIdentityService's single cache/taxonomy
    tmdb.getMediaObject = async (
        type: string,
        tmdbId: string,
        season?: number,
        episode?: number
    ) => {
        const kind = type === 'movie' ? 'movie' : ('tv' as const);
        try {
            const res = await globalMediaIdentity.resolve(
                kind as never,
                String(tmdbId),
                season,
                episode
            );
            return res.media;
        } catch (err) {
            // For validation-type errors (invalid id/season) propagate as-is so callers get 400
            if (
                err &&
                typeof err === 'object' &&
                'code' in (err as Record<string, unknown>)
            ) {
                throw err;
            }
            return origGetMedia(type, tmdbId, season, episode);
        }
    };
    tmdb.getImdbId = async (tmdbId: string, type: string) => {
        const kind = type === 'movie' ? 'movie' : ('tv' as const);
        try {
            const res = await globalMediaIdentity.resolve(
                kind as never,
                String(tmdbId)
            );
            return res.media.imdbId || undefined;
        } catch {
            return origGetImdb(tmdbId, type);
        }
    };
    console.log(
        '[media] patched TMDBService to delegate to MediaIdentityService'
    );
}

function patchCacheRevision(
    server: OMSSServer,
    selection: ProviderSelectionService,
    cacheManager: CacheManager,
    cfg: AppConfig
): void {
    const cache = (
        server as unknown as {
            cache: {
                get: (k: string) => Promise<unknown>;
                set: (k: string, v: unknown, ttl?: number) => Promise<unknown>;
                clear: () => Promise<void>;
            };
        }
    ).cache;

    cache.get = async (key: string) => {
        if (key.startsWith('movie:') || key.startsWith('tv:')) {
            const revKey = buildAggregateResultKey(selection.revision, key);
            const v = await cacheManager.get(revKey);
            if (v != null) return v;
            return null;
        }
        return cacheManager.get(key);
    };

    cache.set = async (key: string, value: unknown, ttl?: number) => {
        if (key.startsWith('movie:') || key.startsWith('tv:')) {
            const revKey = buildAggregateResultKey(selection.revision, key);
            if (
                value &&
                typeof value === 'object' &&
                value !== null &&
                !Array.isArray(value)
            ) {
                (value as Record<string, unknown>).revision =
                    selection.revision;
            }
            await cacheManager.set(revKey, value, ttl ?? cfg.cacheTtlSources);
            return;
        }
        await cacheManager.set(key, value, ttl);
    };

    cache.clear = async () => {
        await cacheManager.invalidateOnRevisionChange(selection.revision);
    };

    console.log(
        '[cache] routed OMSS cache through CacheManager (namespaced keys, SWR & SingleFlight active)'
    );
}

function patchSourceService(
    server: OMSSServer,
    selection: ProviderSelectionService,
    cfg: AppConfig
): void {
    // Original preserved for debugging if needed
    void (
        server as unknown as {
            sourceService: {
                fetchFromProviders: (
                    type: string,
                    media: unknown
                ) => Promise<unknown[]>;
            };
        }
    ).sourceService.fetchFromProviders.bind(
        (server as unknown as { sourceService: unknown }).sourceService
    );
    const svc = (
        server as unknown as { sourceService: Record<string, unknown> }
    ).sourceService;

    // Replace with selection-aware, bounded-concurrency, priority-ordered fetch.
    // Bulk semantics: Aggregate mode — query eligible providers concurrently with
    // bounded concurrency (4) and return all usable sources in priority order.
    // Fast-first mode is available via selection.fetchFastFirst for callers that
    // want early stop; progressive mode remains single-provider via /v1/.../providers/:id.
    (
        svc as {
            fetchFromProviders: (
                type: string,
                media: unknown
            ) => Promise<unknown[]>;
        }
    ).fetchFromProviders = async (type: string, media: unknown) => {
        const m = media as import('@omss/framework').ProviderMediaObject;
        let providers = selection.selectStreamProviders(m);

        // Phase 7 §10.4 — cap per-request source-lookup cost: providers are
        // priority-ordered, so truncating keeps the best-first subset.
        if (cfg.bulkMaxProvidersPerRequest > 0) {
            providers = providers.slice(0, cfg.bulkMaxProvidersPerRequest);
        }
        if (providers.length === 0) return [];

        // Phase 7 §10.1 — bulk lookups draw from the bulk pool, weighted by
        // fan-out so a 16-provider aggregate reserves proportionally more
        // capacity than a 2-provider one and cannot starve other classes.
        const bulkPool = globalConcurrency.pool('bulk-scrape');
        return bulkPool.withSlot(
            () => fetchFromProvidersBounded(server, type, m, providers, cfg),
            { weight: Math.max(1, Math.ceil(providers.length / 4)) }
        );
    };

    // Also ensure buildResponse respects upstream dedup when grants are opaque.
    // Patch to use provenance-based dedup when available — uses full upstream identity
    // (scheme + host + port + path + sorted query + headers) via normalizeUpstreamUrl.
    const originalBuild = (
        svc as { buildResponse: (results: unknown[]) => unknown }
    ).buildResponse;
    if (originalBuild) {
        (
            svc as { buildResponse: (results: unknown[]) => unknown }
        ).buildResponse = function (results: unknown[]) {
            try {
                const asArray = results as Array<{
                    sources: Array<{
                        url: string;
                        provenance?: {
                            upstreamUrl: string;
                            headers?: Record<string, string>;
                        };
                    }>;
                }>;
                const hasProvenance = asArray.some((r) =>
                    r.sources.some((s) =>
                        Boolean(
                            (s as unknown as { provenance?: unknown })
                                .provenance
                        )
                    )
                );
                if (hasProvenance) {
                    const seen = new Set<string>();
                    const deduped = asArray.map((r) => {
                        const filtered: unknown[] = [];
                        for (const s of r.sources as Array<{
                            provenance?: {
                                upstreamUrl: string;
                                headers?: Record<string, string>;
                            };
                            url: string;
                        }>) {
                            const prov = (
                                s as unknown as {
                                    provenance?: {
                                        upstreamUrl: string;
                                        headers?: Record<string, string>;
                                    };
                                }
                            ).provenance;
                            const upstream = prov?.upstreamUrl ?? s.url;
                            const headers = prov?.headers;
                            const headerKey = headers
                                ? JSON.stringify(
                                      Object.entries(headers)
                                          .sort((a, b) =>
                                              a[0].localeCompare(b[0])
                                          )
                                          .map(
                                              ([k, v]) =>
                                                  `${k.toLowerCase()}:${v}`
                                          )
                                  )
                                : '';
                            const key =
                                normalizeUpstreamUrl(upstream) +
                                '|' +
                                headerKey;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            filtered.push(s);
                        }
                        return { ...r, sources: filtered };
                    });
                    return (originalBuild as (r: unknown[]) => unknown).call(
                        this,
                        deduped
                    );
                }
            } catch {
                /* fallback */
            }
            return (originalBuild as (r: unknown[]) => unknown).call(
                this,
                results
            );
        };
    }

    console.log(
        `[selection] patched SourceService.fetchFromProviders to use ProviderSelectionService (aggregate mode, concurrency=4)`
    );
}

/**
 * Aggregate fetch over a pre-selected provider list with an absolute
 * deadline (Phase 7: cfg.sourceLookupDeadlineMs) and batched bounded
 * concurrency. The bulk-scrape pool slot is held by the caller.
 */
async function fetchFromProvidersBounded(
    server: OMSSServer,
    type: string,
    m: import('@omss/framework').ProviderMediaObject,
    providers: Array<{ providerId: string; name: string }>,
    cfg: AppConfig
): Promise<unknown[]> {
    // Absolute deadline for the whole bulk aggregation — prevents multiple IDs/retries
    // from exceeding the request budget.
    const bulkCtrl = new AbortController();
    const bulkTimeout = setTimeout(() => {
        try {
            bulkCtrl.abort(
                Object.assign(new Error('bulk deadline exceeded'), {
                    name: 'TimeoutError'
                })
            );
        } catch {
            /* ignore */
        }
    }, cfg.sourceLookupDeadlineMs);
    const bulkSignal = bulkCtrl.signal;

    // Bounded concurrency aggregate — cancellable
    const concurrency = 4;
    const results: unknown[] = [];
    try {
        for (let i = 0; i < providers.length; i += concurrency) {
            if (bulkSignal.aborted) break;
            const batch = providers.slice(i, i + concurrency);
            const settled = await Promise.allSettled(
                batch.map(async (addon) => {
                    if (bulkSignal.aborted)
                        return { sources: [], subtitles: [], diagnostics: [] };
                    const provider = (
                        server as unknown as {
                            getRegistry: () => {
                                getProvider(id: string): {
                                    getMovieSources(
                                        m: unknown,
                                        s?: AbortSignal
                                    ): Promise<unknown>;
                                    getTVSources(
                                        m: unknown,
                                        s?: AbortSignal
                                    ): Promise<unknown>;
                                };
                            };
                        }
                    )
                        .getRegistry()
                        .getProvider(addon.providerId);
                    if (!provider)
                        return { sources: [], subtitles: [], diagnostics: [] };
                    try {
                        const res =
                            type === 'movie'
                                ? await provider.getMovieSources(
                                      m as never,
                                      bulkSignal
                                  )
                                : await provider.getTVSources(
                                      m as never,
                                      bulkSignal
                                  );
                        return res;
                    } catch (err) {
                        if (
                            (err as Error)?.name === 'AbortError' ||
                            (err as Error)?.name === 'TimeoutError'
                        ) {
                            return {
                                sources: [],
                                subtitles: [],
                                diagnostics: []
                            };
                        }
                        return {
                            sources: [],
                            subtitles: [],
                            diagnostics: [
                                {
                                    code: 'PROVIDER_ERROR',
                                    message: `${addon.name}: ${err instanceof Error ? err.message : String(err)}`,
                                    field: '',
                                    severity: 'error'
                                }
                            ]
                        };
                    }
                })
            );
            for (const s of settled) {
                if (s.status === 'fulfilled') results.push(s.value);
            }
        }
    } finally {
        clearTimeout(bulkTimeout);
    }

    // Keep results in selection priority order (already) but ensure mapping is 1:1
    // Providers already ordered, results array is in same order as batch slicing.
    return results;
}

function sendProviderError(
    reply: import('fastify').FastifyReply,
    err: unknown
) {
    // Phase 7 §10.1 — pool saturation surfaces as 503 OVERLOADED with a
    // retry hint instead of a generic 5xx.
    const code = (err as { code?: string }).code;
    if (code === 'SEMAPHORE_FULL' || code === 'QUEUE_TIMEOUT') {
        reply.header('Retry-After', '2');
        const message =
            err instanceof Error ? err.message : 'Concurrency pool saturated';
        return reply.code(503).send({
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'OVERLOADED',
                    message,
                    field: '',
                    severity: 'warning'
                }
            ],
            error: message
        });
    }
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
