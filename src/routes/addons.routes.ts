/**
 * Addon management REST API (mounted on the OMSS Fastify instance).
 *
 *   GET    /v1/addons                     list all installed addons (operator+)
 *   GET    /v1/addons/:providerId         one addon (operator+)
 *   DELETE /v1/addons/:providerId         uninstall (admin)
 *   PATCH  /v1/addons/:providerId         { enabled?, timeoutMs? } (operator)
 *   POST   /v1/addons/reorder             { order: string[] } (operator)
 *   POST   /v1/addons/:providerId/refresh re-fetch manifest (operator)
 *   GET    /v1/audit                      recent audit events (admin)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AddonManager } from '../addons/manager.js';
import { toPublicAddon } from '../addons/manager.js';
import type { HealthMonitor } from '../health/monitor.js';
import type { DebridProviderId } from '../debrid/types.js';
import { debridService } from '../debrid/service.js';
import { makeAuthGuard, enforceRateLimit } from './auth.js';
import {
    createRateLimiter,
    RATE_LIMITS,
    rateLimitKey
} from '../security/rateLimit.js';
import { actorFromAuth, type AuditLogger } from '../security/audit.js';
import type { Role } from '../security/auth.js';
import { getRateLimitIp } from '../security/auth.js';
import type {
    IStorageBackend,
    SanitizedExportData,
    JobRecord
} from '../storage/types.js';
import { importSanitizedConfiguration } from '../storage/importer.js';
import type { CacheManager } from '../cache/manager.js';
import type { JobEngine } from '../jobs/engine.js';

function clientIp(
    request: FastifyRequest,
    cfg?: AppConfig
): string | undefined {
    if (cfg) return getRateLimitIp(request, cfg);
    const sock = (request.socket?.remoteAddress as string | undefined)?.replace(
        /^::ffff:/,
        ''
    );
    return sock ?? request.ip;
}

function requireRole(role: Role) {
    return { role };
}

export function registerAddonRoutes(
    app: FastifyInstance,
    manager: AddonManager,
    cfg: AppConfig,
    monitor?: HealthMonitor,
    audit?: AuditLogger,
    storage?: IStorageBackend,
    cacheManager?: CacheManager,
    jobEngine?: JobEngine
): void {
    const viewerGuard = makeAuthGuard(cfg, requireRole('viewer'));
    const operatorGuard = makeAuthGuard(cfg, requireRole('operator'));
    const adminGuard = makeAuthGuard(cfg, requireRole('admin'));
    const limiter = createRateLimiter();

    async function auditMutation(
        request: FastifyRequest,
        action: string,
        target: string | undefined,
        outcome: 'success' | 'failure' | 'denied',
        extra?: {
            before?: unknown;
            after?: unknown;
            reason?: string;
            meta?: Record<string, unknown>;
        }
    ): Promise<void> {
        if (!audit) return;
        await audit.record({
            actor: actorFromAuth(request.auth?.actor, clientIp(request, cfg)),
            action,
            target,
            requestId: request.id,
            revision: manager.getRevision(),
            outcome,
            before: extra?.before,
            after: extra?.after,
            reason: extra?.reason,
            meta: extra?.meta
        });
    }

    app.get('/v1/addons', { preHandler: viewerGuard }, async (_req, reply) => {
        return reply.code(200).send({
            addons: manager.list().map(toPublicAddon),
            store: manager.describeStore(),
            revision: manager.getRevision()
        });
    });

    app.get<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId',
        { preHandler: viewerGuard },
        async (req, reply) => {
            const addon = manager.get(req.params.providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' }
                });
            }
            // Redacted public view + non-secret manifest fields only.
            const pub = toPublicAddon(addon);
            return reply.code(200).send({
                ...pub,
                revision: manager.getRevision(),
                // Manifest is useful for operators; strip nothing secret-bearing
                // beyond what redaction already does on URLs.
                manifest: {
                    id: addon.manifest.id,
                    name: addon.manifest.name,
                    version: addon.manifest.version,
                    description: addon.manifest.description,
                    types: addon.manifest.types,
                    resources: addon.manifest.resources,
                    idPrefixes: addon.manifest.idPrefixes,
                    catalogs: addon.manifest.catalogs,
                    logo: addon.manifest.logo,
                    background: addon.manifest.background
                }
            });
        }
    );

    app.delete<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId',
        { preHandler: adminGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('remove', req.auth?.actor?.id, ip),
                    RATE_LIMITS.remove.limit,
                    RATE_LIMITS.remove.windowMs
                ))
            ) {
                return;
            }
            const before = manager.get(req.params.providerId);
            const removed = await manager.remove(req.params.providerId);
            if (!removed) {
                await auditMutation(
                    req,
                    'addon.remove',
                    req.params.providerId,
                    'failure',
                    {
                        reason: 'not found'
                    }
                );
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' }
                });
            }
            await auditMutation(
                req,
                'addon.remove',
                req.params.providerId,
                'success',
                {
                    before: before ? toPublicAddon(before) : undefined
                }
            );
            return reply.code(200).send({
                ok: true,
                removed: req.params.providerId,
                revision: manager.getRevision()
            });
        }
    );

    app.patch<{
        Params: { providerId: string };
        Body: { enabled?: boolean; timeoutMs?: number };
    }>(
        '/v1/addons/:providerId',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('mutate', req.auth?.actor?.id, ip),
                    RATE_LIMITS.mutate.limit,
                    RATE_LIMITS.mutate.windowMs
                ))
            ) {
                return;
            }
            const { providerId } = req.params;
            const body = req.body ?? {};
            let addon = manager.get(providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' }
                });
            }
            const before = toPublicAddon(addon);
            if (typeof body.enabled === 'boolean') {
                addon = await manager.setEnabled(providerId, body.enabled);
            }
            if (typeof body.timeoutMs === 'number') {
                addon = await manager.setTimeout(providerId, body.timeoutMs);
            }
            await auditMutation(req, 'addon.patch', providerId, 'success', {
                before,
                after: addon ? toPublicAddon(addon) : undefined
            });
            return reply.code(200).send({
                ok: true,
                addon: addon && toPublicAddon(addon),
                revision: manager.getRevision()
            });
        }
    );

    app.post<{ Body: { order?: string[] } }>(
        '/v1/addons/reorder',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const order = req.body?.order;
            if (!Array.isArray(order)) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_PARAMETER',
                        message: 'Body must be { order: string[] }'
                    }
                });
            }
            const beforeOrder = manager.list().map((a) => a.providerId);
            await manager.reorder(order);
            await auditMutation(req, 'addon.reorder', undefined, 'success', {
                before: { order: beforeOrder },
                after: { order }
            });
            return reply.code(200).send({
                ok: true,
                addons: manager.list().map(toPublicAddon),
                revision: manager.getRevision()
            });
        }
    );

    app.post<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId/refresh',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('refresh', req.auth?.actor?.id, ip),
                    RATE_LIMITS.refresh?.limit ?? RATE_LIMITS.mutate.limit,
                    RATE_LIMITS.refresh?.windowMs ?? RATE_LIMITS.mutate.windowMs
                ))
            ) {
                return;
            }
            const result = await manager.refresh(req.params.providerId);
            await auditMutation(
                req,
                'addon.refresh',
                req.params.providerId,
                result.ok ? 'success' : 'failure',
                {
                    reason: result.error,
                    after: result.addon && toPublicAddon(result.addon)
                }
            );
            const status = result.ok ? 200 : 400;
            return reply.code(status).send({
                ...result,
                addon: result.addon ? toPublicAddon(result.addon) : undefined,
                revision: manager.getRevision()
            });
        }
    );

    // ── settings (debrid) ──────────────────────────────────────────────────────
    app.get(
        '/v1/settings',
        { preHandler: viewerGuard },
        async (_req, reply) => {
            return reply.code(200).send({
                debrid: {
                    ...debridService.status(),
                    lockedByEnv: manager.debridLockedByEnv()
                },
                authMode: cfg.authMode,
                secureProxy: cfg.secureProxy,
                revision: manager.getRevision()
            });
        }
    );

    app.patch<{ Body: { provider?: DebridProviderId; apiKey?: string } }>(
        '/v1/settings/debrid',
        { preHandler: adminGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('debrid', req.auth?.actor?.id, ip),
                    RATE_LIMITS.debrid.limit,
                    RATE_LIMITS.debrid.windowMs
                ))
            ) {
                return;
            }
            if (manager.debridLockedByEnv()) {
                await auditMutation(
                    req,
                    'settings.debrid',
                    'debrid',
                    'denied',
                    {
                        reason: 'locked by env'
                    }
                );
                return reply.code(409).send({
                    error: {
                        code: 'LOCKED',
                        message:
                            'Debrid is configured via environment (DEBRID_*) and cannot be changed at runtime'
                    }
                });
            }
            const body = req.body ?? {};
            // Never log apiKey — audit redaction also covers it.
            await manager.updateDebridSettings({
                provider: body.provider,
                apiKey: body.apiKey
            });
            await auditMutation(req, 'settings.debrid', 'debrid', 'success', {
                after: {
                    provider: body.provider,
                    apiKeySet: Boolean(body.apiKey)
                }
            });
            return reply.code(200).send({
                ok: true,
                debrid: debridService.status(),
                revision: manager.getRevision()
            });
        }
    );

    app.post(
        '/v1/settings/debrid/check',
        { preHandler: adminGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('debrid', req.auth?.actor?.id, ip),
                    RATE_LIMITS.debrid.limit,
                    RATE_LIMITS.debrid.windowMs
                ))
            ) {
                return;
            }
            const result = await debridService.checkCredentials();
            await auditMutation(
                req,
                'settings.debrid.check',
                'debrid',
                result.ok ? 'success' : 'failure',
                {
                    reason: result.error,
                    meta: {
                        errorKind: result.errorKind,
                        user: result.user
                    }
                }
            );
            return reply.code(result.ok ? 200 : 400).send(result);
        }
    );

    // ── debrid transfers (uncached workflows) ─────────────────────────────────
    app.post<{
        Body: {
            infoHash?: string;
            sources?: string[];
            fileIdx?: number;
            season?: number;
            episode?: number;
            title?: string;
            maxWaitSec?: number;
        };
    }>(
        '/v1/debrid/transfers',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('debrid', req.auth?.actor?.id, ip),
                    RATE_LIMITS.debrid.limit,
                    RATE_LIMITS.debrid.windowMs
                ))
            ) {
                return;
            }

            const body = req.body ?? {};
            if (!body.infoHash || typeof body.infoHash !== 'string') {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARAMETER',
                        message: 'Provide { infoHash: string }'
                    }
                });
            }

            if (!jobEngine) {
                return reply.code(503).send({
                    error: {
                        code: 'JOB_ENGINE_UNAVAILABLE',
                        message: 'Job engine is required for background transfers'
                    }
                });
            }

            if (storage) {
                const allTransfers = await storage.listJobs({
                    type: 'uncached-transfer',
                    limit: 100
                });
                const activeTransfers = allTransfers.filter(
                    (j) => j.status === 'queued' || j.status === 'running'
                );

                // 1. Account / Global limit
                const globalLimit = cfg.debridMaxGlobalTransfers ?? 10;
                if (activeTransfers.length >= globalLimit) {
                    return reply.code(429).send({
                        error: {
                            code: 'GLOBAL_TRANSFER_LIMIT_EXCEEDED',
                            message: `Active transfer capacity reached (${activeTransfers.length}/${globalLimit} concurrent). Please wait for running transfers to complete.`
                        }
                    });
                }

                // 2. Per-user / requester limit
                const userLimit = cfg.debridMaxUserTransfers ?? 3;
                const hasAuthenticatedUser =
                    req.auth?.actor?.id &&
                    req.auth.actor.id !== 'anon' &&
                    req.auth.actor.id !== 'local-dev';
                const requesterId = hasAuthenticatedUser
                    ? req.auth?.actor?.id
                    : undefined;

                const userActiveCount = activeTransfers.filter((j) => {
                    const r = j.requester;
                    if (requesterId && r?.id && r.id === requesterId) {
                        return true;
                    }
                    if (ip && r?.ip && r.ip === ip) {
                        return true;
                    }
                    return false;
                }).length;

                if (userActiveCount >= userLimit) {
                    return reply.code(429).send({
                        error: {
                            code: 'USER_TRANSFER_LIMIT_EXCEEDED',
                            message: `Per-user transfer limit reached (${userActiveCount}/${userLimit} concurrent).`
                        }
                    });
                }
            }

            const job = await jobEngine.enqueue(
                'uncached-transfer',
                {
                    infoHash: body.infoHash.trim(),
                    sources: body.sources,
                    fileIdx: body.fileIdx,
                    season: body.season,
                    episode: body.episode,
                    title: body.title,
                    maxWaitSec: body.maxWaitSec
                },
                {
                    dedupKey: `transfer_${body.infoHash.toLowerCase().trim()}`,
                    requester: {
                        id: req.auth?.actor?.id,
                        ip: clientIp(req, cfg),
                        role: req.auth?.actor?.role
                    }
                }
            );

            await auditMutation(
                req,
                'debrid.transfer.queued',
                job.id,
                'success',
                {
                    meta: {
                        infoHash: body.infoHash,
                        jobId: job.id
                    }
                }
            );

            return reply.code(202).send({
                ok: true,
                jobId: job.id,
                status: job.status,
                message: 'Debrid transfer queued'
            });
        }
    );

    function sanitizeTransferJobView(job: JobRecord) {
        let result = job.result;
        if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>;
            if (typeof r.url === 'string') {
                const isGrant = r.url.includes('/v1/proxy/grant/');
                if (!isGrant) {
                    result = {
                        ...r,
                        url: '[PROTECTED_PLAYBACK_GRANT]'
                    };
                }
            }
        }
        return {
            id: job.id,
            status: job.status,
            progress: job.progress,
            result,
            error: job.error,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt
        };
    }

    app.get<{ Params: { jobId: string } }>(
        '/v1/debrid/transfers/:jobId',
        { preHandler: operatorGuard },
        async (req, reply) => {
            if (!storage) {
                return reply.code(503).send({
                    error: {
                        code: 'STORAGE_UNAVAILABLE',
                        message: 'Storage unavailable'
                    }
                });
            }
            const job = await storage.getJob(req.params.jobId);
            if (!job || job.type !== 'uncached-transfer') {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Transfer job not found'
                    }
                });
            }
            return reply.code(200).send(sanitizeTransferJobView(job));
        }
    );

    app.delete<{ Params: { jobId: string } }>(
        '/v1/debrid/transfers/:jobId',
        { preHandler: operatorGuard },
        async (req, reply) => {
            if (!jobEngine || !storage) {
                return reply.code(503).send({
                    error: {
                        code: 'JOB_ENGINE_UNAVAILABLE',
                        message: 'Job engine unavailable'
                    }
                });
            }
            const job = await storage.getJob(req.params.jobId);
            if (!job || job.type !== 'uncached-transfer') {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Transfer job not found'
                    }
                });
            }
            await jobEngine.cancel(job.id);
            await auditMutation(
                req,
                'debrid.transfer.cancel',
                job.id,
                'success'
            );
            const updated = await storage.getJob(job.id);
            return reply
                .code(200)
                .send({
                    ok: true,
                    job: updated ? sanitizeTransferJobView(updated) : null
                });
        }
    );

    app.get(
        '/v1/debrid/transfers',
        { preHandler: operatorGuard },
        async (_req, reply) => {
            if (!storage) {
                return reply.code(200).send({ transfers: [] });
            }
            const jobs = await storage.listJobs({
                type: 'uncached-transfer',
                limit: 50
            });
            return reply.code(200).send({
                transfers: jobs.map(sanitizeTransferJobView)
            });
        }
    );

    // ── health ───────────────────────────────────────────────────────────────
    app.post(
        '/v1/addons/health/check',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            if (
                !(await enforceRateLimit(
                    reply,
                    limiter,
                    rateLimitKey('health', req.auth?.actor?.id, ip),
                    RATE_LIMITS.health.limit,
                    RATE_LIMITS.health.windowMs
                ))
            ) {
                return;
            }
            if (!monitor) {
                return reply.code(503).send({
                    error: {
                        code: 'UNAVAILABLE',
                        message: 'Health monitor not enabled'
                    }
                });
            }
            const summary = await monitor.checkAll();
            await auditMutation(
                req,
                'addon.health.check',
                undefined,
                'success',
                {
                    after: summary
                }
            );
            return reply.code(200).send({
                ok: true,
                ...summary,
                addons: manager.list().map(toPublicAddon),
                revision: manager.getRevision()
            });
        }
    );

    // ── audit (admin) ────────────────────────────────────────────────────────
    if (audit) {
        app.get<{ Querystring: { limit?: string } }>(
            '/v1/audit',
            { preHandler: adminGuard },
            async (req, reply) => {
                const limit = Math.min(
                    500,
                    Math.max(1, Number(req.query.limit) || 100)
                );
                return reply.code(200).send({
                    events: audit.recent(limit)
                });
            }
        );
    }

    // ── configuration export & import (Phase 3.1) ───────────────────────────
    app.get(
        '/v1/settings/export',
        { preHandler: adminGuard },
        async (_req, reply) => {
            if (storage) {
                const data = await storage.exportSanitized();
                return reply.code(200).send(data);
            }
            const data = {
                version: 1,
                revision: manager.getRevision(),
                addons: manager.list().map((a) => {
                    const pub = toPublicAddon(a);
                    return {
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
                        capabilities: pub.capabilities,
                        addedAt: a.addedAt,
                        updatedAt: a.updatedAt
                    };
                }),
                exportedAt: new Date().toISOString()
            };
            return reply.code(200).send(data);
        }
    );

    app.post<{ Body: SanitizedExportData }>(
        '/v1/settings/import',
        { preHandler: adminGuard },
        async (req, reply) => {
            const body = req.body;
            if (!body || !Array.isArray(body.addons)) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_PAYLOAD',
                        message: "Invalid configuration payload: 'addons' array is required"
                    }
                });
            }
            if (storage) {
                const res = await importSanitizedConfiguration(storage, body);
                await auditMutation(req, 'settings.import', undefined, 'success', {
                    after: { importedCount: res.imported }
                });
                return reply.code(200).send({ ok: true, imported: res.imported });
            }
            return reply.code(200).send({ ok: true, imported: 0 });
        }
    );

    // ── cache metrics & bypass (Phase 3.2) ───────────────────────────────────
    app.get(
        '/v1/cache/metrics',
        { preHandler: viewerGuard },
        async (_req, reply) => {
            if (cacheManager) {
                return reply.code(200).send({
                    metrics: cacheManager.snapshot(),
                    flight: cacheManager.flight.metrics()
                });
            }
            return reply.code(200).send({
                metrics: {
                    hits: 0,
                    misses: 0,
                    swrHits: 0,
                    sets: 0,
                    evictions: 0,
                    bypasses: 0,
                    cardinality: 0,
                    backend: 'memory'
                }
            });
        }
    );
}
