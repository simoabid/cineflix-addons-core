/**
 * Addon management REST API (mounted on the OMSS Fastify instance).
 *
 *   GET    /v1/addons                     list all installed addons with pagination, filter, search, sort (operator+)
 *   GET    /v1/addons/:providerId         one addon (operator+) with protected diagnostic view (admin+)
 *   DELETE /v1/addons/:providerId         uninstall (admin) with optimistic concurrency
 *   PATCH  /v1/addons/:providerId         { enabled?, timeoutMs? } (operator) with optimistic concurrency
 *   POST   /v1/addons/reorder             { order: string[] } (operator) with optimistic concurrency
 *   POST   /v1/addons/:providerId/refresh re-fetch manifest (operator)
 *   POST   /v1/addons/health/check        synchronous summary or 202 async sweep (?async=true)
 *   GET    /v1/audit                      recent audit events (admin)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AddonManager } from '../addons/manager.js';
import { toPublicAddon } from '../addons/manager.js';
import { deriveCapabilities } from '../capabilities/index.js';
import type { HealthMonitor } from '../health/monitor.js';
import { debridService } from '../debrid/service.js';
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
import { globalReliability } from '../reliability/circuit.js';
import {
    addonsQueryValidator,
    providerIdValidator,
    patchAddonBodyValidator,
    reorderAddonsBodyValidator,
    manualQuarantineBodyValidator,
    patchDebridBodyValidator,
    debridTransferBodyValidator
} from '../validation/schemas.js';
import {
    checkOptimisticConcurrency,
    formatValidationError
} from '../validation/validator.js';
import { makeAuthGuard, enforceRateLimit } from './auth.js';

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

    // ── GET /v1/addons (paginated, searchable, filterable, sortable) ───────────
    app.get<{ Querystring: Record<string, unknown> }>(
        '/v1/addons',
        { preHandler: viewerGuard },
        async (req, reply) => {
            const queryRes = addonsQueryValidator(req.query);
            if (!queryRes.ok && queryRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(queryRes.errors, req.id));
            }
            const q = queryRes.data ?? {};
            let list = manager.list();

            // 1. Search filter
            if (q.search) {
                const s = q.search.toLowerCase();
                list = list.filter(
                    (a) =>
                        a.name.toLowerCase().includes(s) ||
                        a.providerId.toLowerCase().includes(s) ||
                        a.slug.toLowerCase().includes(s) ||
                        (a.manifest.description &&
                            a.manifest.description.toLowerCase().includes(s))
                );
            }

            // 2. Capability filter
            if (q.capability && q.capability !== 'all') {
                list = list.filter((a) => {
                    const caps =
                        a.capabilities ?? deriveCapabilities(a.manifest);
                    const hasStream = Array.isArray(caps.stream)
                        ? caps.stream.length > 0
                        : Boolean(caps.stream);
                    const hasSubtitles = Array.isArray(caps.subtitles)
                        ? caps.subtitles.length > 0
                        : Boolean(caps.subtitles);
                    const hasCatalog = Boolean(caps.catalog);
                    const hasMeta = Boolean(caps.meta);
                    if (q.capability === 'stream') return hasStream;
                    if (q.capability === 'subtitles') return hasSubtitles;
                    if (q.capability === 'catalog') return hasCatalog;
                    if (q.capability === 'meta') return hasMeta;
                    return true;
                });
            }

            // 3. Health filter
            if (q.health && q.health !== 'all') {
                list = list.filter((a) => {
                    if (q.health === 'healthy')
                        return a.health?.healthy === true;
                    if (q.health === 'unhealthy')
                        return a.health?.healthy === false;
                    if (q.health === 'unknown')
                        return a.health === undefined || a.health === null;
                    return true;
                });
            }

            // 4. Enabled filter
            if (q.enabled !== undefined) {
                list = list.filter((a) => a.enabled === q.enabled);
            }

            // 5. Admission state filter
            if (q.admissionState && q.admissionState !== 'all') {
                list = list.filter(
                    (a) =>
                        (a.admissionState ??
                            (a.enabled ? 'validated' : 'disabled')) ===
                        q.admissionState
                );
            }

            // 6. Sorting
            const sortKey = q.sort ?? 'order';
            const direction = q.direction === 'desc' ? -1 : 1;

            list.sort((a, b) => {
                let cmp = 0;
                if (sortKey === 'order') {
                    cmp = a.order - b.order;
                } else if (sortKey === 'name') {
                    cmp = a.name.localeCompare(b.name);
                } else if (sortKey === 'addedAt') {
                    cmp =
                        new Date(a.addedAt).getTime() -
                        new Date(b.addedAt).getTime();
                } else if (sortKey === 'updatedAt') {
                    cmp =
                        new Date(a.updatedAt).getTime() -
                        new Date(b.updatedAt).getTime();
                } else if (sortKey === 'health') {
                    const hA =
                        a.health?.healthy === true
                            ? 1
                            : a.health?.healthy === false
                              ? -1
                              : 0;
                    const hB =
                        b.health?.healthy === true
                            ? 1
                            : b.health?.healthy === false
                              ? -1
                              : 0;
                    cmp = hA - hB;
                }
                if (cmp === 0) cmp = a.providerId.localeCompare(b.providerId);
                return cmp * direction;
            });

            // 7. Pagination
            const page = q.page ?? 1;
            const limit = q.limit ?? 50;
            const total = list.length;
            const totalPages = Math.ceil(total / limit) || 1;
            const startIndex = (page - 1) * limit;
            const paginated = list.slice(startIndex, startIndex + limit);

            reply.header('x-provider-revision', String(manager.getRevision()));
            reply.header('ETag', `"rev-${manager.getRevision()}"`);

            return reply.code(200).send({
                addons: paginated.map(toPublicAddon),
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages,
                    hasMore: page < totalPages
                },
                store: manager.describeStore(),
                revision: manager.getRevision()
            });
        }
    );

    // ── GET /v1/addons/:providerId ────────────────────────────────────────────
    app.get<{
        Params: { providerId: string };
        Querystring: { raw?: string; diagnostics?: string };
    }>(
        '/v1/addons/:providerId',
        { preHandler: viewerGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;
            const addon = manager.get(providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' },
                    requestId: req.id
                });
            }

            const isRawRequested =
                req.query.raw === 'true' || req.query.diagnostics === 'true';
            const isAdmin = req.auth?.actor?.role === 'admin';

            const pub = toPublicAddon(addon);
            reply.header('x-provider-revision', String(manager.getRevision()));
            reply.header('ETag', `"rev-${manager.getRevision()}"`);

            if (isRawRequested && isAdmin) {
                const metrics = globalReliability.getMetrics(providerId);
                const circuitState = globalReliability.getState(providerId);
                return reply.code(200).send({
                    ...pub,
                    admissionState:
                        addon.admissionState ??
                        (addon.enabled ? 'validated' : 'disabled'),
                    timeoutMs: addon.timeoutMs,
                    health: addon.health,
                    revision: manager.getRevision(),
                    manifest: addon.manifest,
                    diagnostics: {
                        circuitState,
                        metrics,
                        timeoutMs: addon.timeoutMs,
                        validationFindings: addon.validationFindings
                    }
                });
            }

            const circuitState = globalReliability.getState(providerId);
            return reply.code(200).send({
                ...pub,
                admissionState:
                    addon.admissionState ??
                    (addon.enabled ? 'validated' : 'disabled'),
                timeoutMs: addon.timeoutMs,
                health: addon.health,
                diagnostics: {
                    circuitState
                },
                revision: manager.getRevision(),
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

    // ── DELETE /v1/addons/:providerId ─────────────────────────────────────────
    app.delete<{
        Params: { providerId: string };
        Body?: { reason?: string };
        Querystring?: { reason?: string };
    }>(
        '/v1/addons/:providerId',
        { preHandler: adminGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;

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

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
                ))
            ) {
                return;
            }

            const rawReason =
                typeof req.body === 'object' &&
                req.body !== null &&
                typeof (req.body as Record<string, unknown>).reason === 'string'
                    ? (req.body as Record<string, string>).reason.trim()
                    : typeof req.query === 'object' &&
                        req.query !== null &&
                        typeof (req.query as Record<string, unknown>).reason ===
                            'string'
                      ? (req.query as Record<string, string>).reason.trim()
                      : undefined;
            const reason = rawReason || 'Operator removal';

            const before = manager.get(providerId);
            const removed = await manager.remove(providerId);
            if (!removed) {
                await auditMutation(
                    req,
                    'addon.remove',
                    providerId,
                    'failure',
                    {
                        reason: 'not found'
                    }
                );
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' },
                    requestId: req.id
                });
            }

            await auditMutation(req, 'addon.remove', providerId, 'success', {
                before: before ? toPublicAddon(before) : undefined,
                reason
            });

            const rev = manager.getRevision();
            reply.header('x-provider-revision', String(rev));
            reply.header('ETag', `"rev-${rev}"`);

            return reply.code(200).send({
                ok: true,
                removed: providerId,
                reason,
                revision: rev
            });
        }
    );

    // ── Phase 7 §10.4: provider quarantine management ────────────────────────
    // Quarantine is an automatic reliability state (repeated circuit opens);
    // release is a deliberate operator action.
    app.get(
        '/v1/quarantine',
        { preHandler: operatorGuard },
        async (_req, reply) => {
            return reply.code(200).send({
                quarantined: globalReliability.listQuarantined(),
                revision: manager.getRevision()
            });
        }
    );

    app.post<{ Params: { providerId: string } }>(
        '/v1/quarantine/:providerId/release',
        { preHandler: adminGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;

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

            const record = globalReliability.getQuarantine(providerId);
            if (!record) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Provider is not quarantined'
                    },
                    requestId: req.id
                });
            }

            globalReliability.releaseQuarantine(providerId);
            await auditMutation(
                req,
                'addon.quarantine.release',
                providerId,
                'success',
                { before: record }
            );

            return reply.code(200).send({
                ok: true,
                released: providerId,
                revision: manager.getRevision()
            });
        }
    );

    app.post<{
        Params: { providerId: string };
        Body: Record<string, unknown>;
    }>(
        '/v1/quarantine/:providerId',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;

            const bodyRes = manualQuarantineBodyValidator(req.body);
            if (!bodyRes.ok && bodyRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(bodyRes.errors, req.id));
            }
            const body = bodyRes.data ?? {};

            // Rate limit: uses 'mutate' bucket because quarantining modifies provider availability & reliability state.
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

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
                ))
            ) {
                return;
            }

            const addon = manager.get(providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Addon not found'
                    },
                    requestId: req.id
                });
            }

            const reason = body.reason || 'Manual operator quarantine';
            globalReliability.quarantine(providerId, reason, {
                ttlMs: body.ttlMs
            });

            await auditMutation(
                req,
                'addon.quarantine.manual',
                providerId,
                'success',
                {
                    reason,
                    meta: { ttlMs: body.ttlMs }
                }
            );

            return reply.code(200).send({
                ok: true,
                quarantined: providerId,
                reason,
                record: globalReliability.getQuarantine(providerId),
                revision: manager.getRevision()
            });
        }
    );

    // ── PATCH /v1/addons/:providerId ──────────────────────────────────────────
    app.patch<{
        Params: { providerId: string };
        Body: Record<string, unknown>;
    }>(
        '/v1/addons/:providerId',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;

            const bodyRes = patchAddonBodyValidator(req.body);
            if (!bodyRes.ok && bodyRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(bodyRes.errors, req.id));
            }
            const body = bodyRes.data!;

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

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
                ))
            ) {
                return;
            }

            let addon = manager.get(providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' },
                    requestId: req.id
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

            const rev = manager.getRevision();
            reply.header('x-provider-revision', String(rev));
            reply.header('ETag', `"rev-${rev}"`);

            return reply.code(200).send({
                ok: true,
                addon: addon && toPublicAddon(addon),
                revision: rev
            });
        }
    );

    // ── POST /v1/addons/reorder ───────────────────────────────────────────────
    app.post<{ Body: Record<string, unknown> }>(
        '/v1/addons/reorder',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const bodyRes = reorderAddonsBodyValidator(req.body);
            if (!bodyRes.ok && bodyRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(bodyRes.errors, req.id));
            }
            const { order } = bodyRes.data!;

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
                ))
            ) {
                return;
            }

            const beforeOrder = manager.list().map((a) => a.providerId);
            await manager.reorder(order);
            await auditMutation(req, 'addon.reorder', undefined, 'success', {
                before: { order: beforeOrder },
                after: { order }
            });

            const rev = manager.getRevision();
            reply.header('x-provider-revision', String(rev));
            reply.header('ETag', `"rev-${rev}"`);

            return reply.code(200).send({
                ok: true,
                addons: manager.list().map(toPublicAddon),
                revision: rev
            });
        }
    );

    // ── POST /v1/addons/:providerId/refresh ───────────────────────────────────
    app.post<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId/refresh',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;

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

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
                ))
            ) {
                return;
            }

            const result = await manager.refresh(providerId);
            await auditMutation(
                req,
                'addon.refresh',
                providerId,
                result.ok ? 'success' : 'failure',
                {
                    reason: result.error,
                    after: result.addon && toPublicAddon(result.addon)
                }
            );
            const status = result.ok ? 200 : 400;
            const rev = manager.getRevision();
            reply.header('x-provider-revision', String(rev));
            reply.header('ETag', `"rev-${rev}"`);

            return reply.code(status).send({
                ...result,
                addon: result.addon ? toPublicAddon(result.addon) : undefined,
                revision: rev
            });
        }
    );

    // ── POST /v1/addons/:providerId/probe ─────────────────────────────────────
    app.post<{ Params: { providerId: string } }>(
        '/v1/addons/:providerId/probe',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const paramRes = providerIdValidator(req.params.providerId);
            if (!paramRes.ok && paramRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramRes.errors, req.id));
            }
            const providerId = paramRes.data!;

            // Rate limit: uses 'refresh' bucket because probing touches upstream network dependencies.
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

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
                ))
            ) {
                return;
            }

            const addon = manager.get(providerId);
            if (!addon) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Addon not found' },
                    requestId: req.id
                });
            }

            const t0 = Date.now();
            const result = await manager.refresh(providerId);
            const latencyMs = Date.now() - t0;

            const circuitState = globalReliability.getState(providerId);
            const isQuarantined = globalReliability.isQuarantined(providerId);
            const healthRecord = {
                healthy: result.ok,
                latencyMs,
                lastChecked: new Date().toISOString(),
                circuitState,
                error: result.ok ? undefined : result.error
            };

            manager.setHealth(providerId, result.ok, healthRecord);

            await auditMutation(
                req,
                'addon.probe',
                providerId,
                result.ok ? 'success' : 'failure',
                {
                    reason: result.error,
                    meta: { latencyMs, circuitState, isQuarantined }
                }
            );

            const rev = manager.getRevision();
            reply.header('x-provider-revision', String(rev));
            reply.header('ETag', `"rev-${rev}"`);

            return reply.code(200).send({
                ok: result.ok,
                providerId,
                healthy: result.ok,
                latencyMs,
                circuitState,
                isQuarantined,
                health: healthRecord,
                error: result.error,
                addon: result.addon
                    ? toPublicAddon(result.addon)
                    : toPublicAddon(addon),
                revision: rev
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

    app.patch<{ Body: Record<string, unknown> }>(
        '/v1/settings/debrid',
        { preHandler: adminGuard },
        async (req, reply) => {
            const bodyRes = patchDebridBodyValidator(req.body);
            if (!bodyRes.ok && bodyRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(bodyRes.errors, req.id));
            }
            const body = bodyRes.data!;

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

            // Optimistic concurrency check
            if (
                !(await checkOptimisticConcurrency(
                    req,
                    reply,
                    manager.getRevision()
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
                    },
                    requestId: req.id
                });
            }

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

            const rev = manager.getRevision();
            reply.header('x-provider-revision', String(rev));
            reply.header('ETag', `"rev-${rev}"`);

            return reply.code(200).send({
                ok: true,
                debrid: debridService.status(),
                revision: rev
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
    app.post<{ Body: Record<string, unknown> }>(
        '/v1/debrid/transfers',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const bodyRes = debridTransferBodyValidator(req.body);
            if (!bodyRes.ok && bodyRes.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(bodyRes.errors, req.id));
            }
            const body = bodyRes.data!;

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

            if (!jobEngine) {
                return reply.code(503).send({
                    error: {
                        code: 'JOB_ENGINE_UNAVAILABLE',
                        message:
                            'Job engine is required for background transfers'
                    },
                    requestId: req.id
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
                        },
                        requestId: req.id
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
                        },
                        requestId: req.id
                    });
                }
            }

            const job = await jobEngine.enqueue(
                'uncached-transfer',
                {
                    infoHash: body.infoHash,
                    sources: body.sources,
                    fileIdx: body.fileIdx,
                    season: body.season,
                    episode: body.episode,
                    title: body.title,
                    maxWaitSec: body.maxWaitSec
                },
                {
                    dedupKey: `transfer_${body.infoHash.toLowerCase()}`,
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
                    },
                    requestId: req.id
                });
            }
            const job = await storage.getJob(req.params.jobId);
            if (!job || job.type !== 'uncached-transfer') {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Transfer job not found'
                    },
                    requestId: req.id
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
                    },
                    requestId: req.id
                });
            }
            const job = await storage.getJob(req.params.jobId);
            if (!job || job.type !== 'uncached-transfer') {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Transfer job not found'
                    },
                    requestId: req.id
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
            return reply.code(200).send({
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

    // ── health check sweep (synchronous or async 202) ─────────────────────────
    app.post<{ Querystring: { async?: string } }>(
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
                    },
                    requestId: req.id
                });
            }

            if (req.query.async === 'true') {
                const res = await monitor.triggerSweep();
                return reply.code(202).send({
                    ok: true,
                    jobId: res.jobId,
                    status: res.queued ? 'queued' : 'completed',
                    message: res.queued
                        ? 'Health check sweep enqueued'
                        : 'Health check completed synchronously'
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
                        message:
                            "Invalid configuration payload: 'addons' array is required"
                    },
                    requestId: req.id
                });
            }
            if (storage) {
                const res = await importSanitizedConfiguration(storage, body);
                await auditMutation(
                    req,
                    'settings.import',
                    undefined,
                    'success',
                    {
                        after: { importedCount: res.imported }
                    }
                );
                return reply
                    .code(200)
                    .send({ ok: true, imported: res.imported });
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
