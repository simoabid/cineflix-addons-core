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
    audit?: AuditLogger
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
        extra?: { before?: unknown; after?: unknown; reason?: string }
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
            reason: extra?.reason
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
            const result = await debridService.check();
            await auditMutation(
                req,
                'settings.debrid.check',
                'debrid',
                result.ok ? 'success' : 'failure',
                { reason: result.error }
            );
            return reply.code(result.ok ? 200 : 400).send(result);
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
}
