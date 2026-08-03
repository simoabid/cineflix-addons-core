/**
 * Addon management REST API (mounted on the OMSS Fastify instance).
 *
 *   GET    /v1/addons                     list all installed addons
 *   GET    /v1/addons/:providerId         one addon (full manifest)
 *   DELETE /v1/addons/:providerId         uninstall
 *   PATCH  /v1/addons/:providerId         { enabled?, timeoutMs? }
 *   POST   /v1/addons/reorder             { order: string[] }
 *   POST   /v1/addons/:providerId/refresh re-fetch manifest
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AddonManager } from '../addons/manager.js';
import type { InstalledAddon } from '../addons/types.js';
import type { HealthMonitor } from '../health/monitor.js';
import type { DebridProviderId } from '../debrid/types.js';
import { debridService } from '../debrid/service.js';
import { makeAdminGuard } from './auth.js';

function toPublicAddon(a: InstalledAddon) {
    return {
        id: a.providerId,
        slug: a.slug,
        name: a.name,
        enabled: a.enabled,
        order: a.order,
        timeoutMs: a.timeoutMs,
        source: a.source,
        manifestUrl: a.manifestUrl,
        baseUrl: a.baseUrl,
        types: a.manifest.types ?? [],
        resources: (a.manifest.resources ?? []).map((r) =>
            typeof r === 'string' ? r : r.name
        ),
        version: a.manifest.version ?? null,
        description: a.manifest.description ?? '',
        logo: a.manifest.logo ?? null,
        health: a.health ?? null,
        addedAt: a.addedAt,
        updatedAt: a.updatedAt
    };
}

export function registerAddonRoutes(
    app: FastifyInstance,
    manager: AddonManager,
    cfg: AppConfig,
    monitor?: HealthMonitor
): void {
    const guard = makeAdminGuard(cfg);

    app.get('/v1/addons', { preHandler: guard }, async (_req, reply) => {
        return reply.code(200).send({
            addons: manager.list().map(toPublicAddon),
            store: manager.describeStore()
        });
    });

    app.get<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId',
        { preHandler: guard },
        async (req, reply) => {
            const addon = manager.get(req.params.providerId);
            if (!addon) {
                return reply
                    .code(404)
                    .send({ error: { code: 'NOT_FOUND', message: 'Addon not found' } });
            }
            return reply.code(200).send({
                ...toPublicAddon(addon),
                manifest: addon.manifest
            });
        }
    );

    app.delete<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId',
        { preHandler: guard },
        async (req, reply) => {
            const removed = await manager.remove(req.params.providerId);
            if (!removed) {
                return reply
                    .code(404)
                    .send({ error: { code: 'NOT_FOUND', message: 'Addon not found' } });
            }
            return reply.code(200).send({ ok: true, removed: req.params.providerId });
        }
    );

    app.patch<{
        Params: { providerId: string };
        Body: { enabled?: boolean; timeoutMs?: number };
    }>(
        '/v1/addons/:providerId',
        { preHandler: guard },
        async (req, reply) => {
            const { providerId } = req.params;
            const body = req.body ?? {};
            let addon = manager.get(providerId);
            if (!addon) {
                return reply
                    .code(404)
                    .send({ error: { code: 'NOT_FOUND', message: 'Addon not found' } });
            }
            if (typeof body.enabled === 'boolean') {
                addon = await manager.setEnabled(providerId, body.enabled);
            }
            if (typeof body.timeoutMs === 'number') {
                addon = await manager.setTimeout(providerId, body.timeoutMs);
            }
            return reply.code(200).send({ ok: true, addon: addon && toPublicAddon(addon) });
        }
    );

    app.post<{ Body: { order?: string[] } }>(
        '/v1/addons/reorder',
        { preHandler: guard },
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
            await manager.reorder(order);
            return reply
                .code(200)
                .send({ ok: true, addons: manager.list().map(toPublicAddon) });
        }
    );

    app.post<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId/refresh',
        { preHandler: guard },
        async (req, reply) => {
            const result = await manager.refresh(req.params.providerId);
            const status = result.ok ? 200 : 400;
            return reply.code(status).send(result);
        }
    );

    // ── settings (debrid) ──────────────────────────────────────────────────────
    app.get('/v1/settings', { preHandler: guard }, async (_req, reply) => {
        return reply.code(200).send({
            debrid: {
                ...debridService.status(),
                lockedByEnv: manager.debridLockedByEnv()
            }
        });
    });

    app.patch<{ Body: { provider?: DebridProviderId; apiKey?: string } }>(
        '/v1/settings/debrid',
        { preHandler: guard },
        async (req, reply) => {
            if (manager.debridLockedByEnv()) {
                return reply.code(409).send({
                    error: {
                        code: 'LOCKED',
                        message:
                            'Debrid is configured via environment (DEBRID_*) and cannot be changed at runtime'
                    }
                });
            }
            const body = req.body ?? {};
            await manager.updateDebridSettings({
                provider: body.provider,
                apiKey: body.apiKey
            });
            return reply.code(200).send({ ok: true, debrid: debridService.status() });
        }
    );

    app.post('/v1/settings/debrid/check', { preHandler: guard }, async (_req, reply) => {
        const result = await debridService.check();
        return reply.code(result.ok ? 200 : 400).send(result);
    });

    // ── health ───────────────────────────────────────────────────────────────
    app.post('/v1/addons/health/check', { preHandler: guard }, async (_req, reply) => {
        if (!monitor) {
            return reply
                .code(503)
                .send({ error: { code: 'UNAVAILABLE', message: 'Health monitor not enabled' } });
        }
        const summary = await monitor.checkAll();
        return reply.code(200).send({
            ok: true,
            ...summary,
            addons: manager.list().map(toPublicAddon)
        });
    });
}
