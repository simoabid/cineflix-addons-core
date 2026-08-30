/**
 * Import REST API (mounted on the OMSS Fastify instance).
 *
 *   POST /v1/addons/import/url         { url } | { urls: string[] }  [admin]
 *   POST /v1/addons/import/stremio     { email, password } | { authKey } [admin]
 *   POST /v1/addons/import/repository  { url } [admin]
 *
 * In Phase 3, asynchronous operations and batch imports are backed by the durable JobEngine.
 * All import mutations are rate-limited and audited. Request bodies that may
 * contain credentials are never written to logs.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AddonManager } from '../addons/manager.js';
import { toPublicAddon } from '../addons/manager.js';
import { importFromUrl, importFromUrls } from '../import/url.js';
import { importFromStremioAccount } from '../import/stremioAccount.js';
import {
    createRateLimiter,
    RATE_LIMITS,
    rateLimitKey
} from '../security/rateLimit.js';
import { actorFromAuth, type AuditLogger } from '../security/audit.js';
import { redactUrl } from '../security/redaction.js';
import type { JobEngine } from '../jobs/engine.js';
import { getRateLimitIp } from '../security/auth.js';
import {
    importUrlBodyValidator,
    importStremioBodyValidator,
    importRepoBodyValidator,
    jobIdValidator
} from '../validation/schemas.js';
import { formatValidationError } from '../validation/validator.js';
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

function publicInstallResult(r: {
    ok: boolean;
    addon?: Parameters<typeof toPublicAddon>[0];
    error?: string;
    updated?: boolean;
    findings?: unknown;
}) {
    return {
        ok: r.ok,
        error: r.error,
        updated: r.updated,
        findings: r.findings,
        addon: r.addon ? toPublicAddon(r.addon) : undefined
    };
}

export function registerImportRoutes(
    app: FastifyInstance,
    manager: AddonManager,
    cfg: AppConfig,
    audit?: AuditLogger,
    jobEngine?: JobEngine
): void {
    const adminGuard = makeAuthGuard(cfg, { role: 'admin' });
    const limiter = createRateLimiter();

    // Idempotency store: key -> { response, expiresAt }
    const idempotency = new Map<
        string,
        { body: unknown; status: number; expiresAt: number }
    >();

    function getIdempotencyKey(req: FastifyRequest): string | undefined {
        const h =
            req.headers['idempotency-key'] ??
            req.headers['Idempotency-Key'] ??
            req.headers['x-idempotency-key'];
        const v = Array.isArray(h) ? h[0] : h;
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 128);
        return undefined;
    }

    function tryIdempotency(
        key: string | undefined,
        reply: import('fastify').FastifyReply
    ): boolean {
        if (!key) return false;
        const entry = idempotency.get(key);
        if (!entry) return false;
        if (entry.expiresAt < Date.now()) {
            idempotency.delete(key);
            return false;
        }
        void reply.code(entry.status).send(entry.body);
        return true;
    }

    function storeIdempotency(
        key: string | undefined,
        status: number,
        body: unknown
    ): void {
        if (!key) return;
        idempotency.set(key, {
            status,
            body,
            expiresAt: Date.now() + 24 * 3600 * 1000
        });
    }

    async function gate(
        req: FastifyRequest,
        reply: import('fastify').FastifyReply
    ): Promise<boolean> {
        const ip = clientIp(req, cfg);
        return enforceRateLimit(
            reply,
            limiter,
            rateLimitKey('import', req.auth?.actor?.id, ip),
            RATE_LIMITS.import.limit,
            RATE_LIMITS.import.windowMs
        );
    }

    // ── import from URL handler (single or batch) ───────────────────────────
    const handleImportUrl = async (
        req: FastifyRequest,
        reply: import('fastify').FastifyReply
    ) => {
        if (!(await gate(req, reply))) return;
        const idemKey = getIdempotencyKey(req);
        if (tryIdempotency(idemKey, reply)) return;

        const val = importUrlBodyValidator(req.body);
        if (!val.ok && val.errors) {
            return reply
                .code(400)
                .send(formatValidationError(val.errors, req.id));
        }
        const body = val.data!;
        const enableOpt =
            typeof body.enable === 'boolean'
                ? { enable: body.enable }
                : undefined;

        // Batch import
        if (Array.isArray(body.urls) && body.urls.length > 0) {
            if (jobEngine) {
                const job = await jobEngine.enqueue(
                    'multi-addon-import',
                    { urls: body.urls, enable: body.enable },
                    {
                        idempotencyKey: idemKey,
                        requester: {
                            id: req.auth?.actor?.id,
                            ip: clientIp(req, cfg),
                            role: req.auth?.actor?.role
                        }
                    }
                );
                const resp = {
                    ok: true,
                    jobId: job.id,
                    status: job.status,
                    message: 'Batch import queued on durable job engine'
                };
                storeIdempotency(idemKey, 202, resp);
                return reply.code(202).send(resp);
            }

            // Fallback synchronous import
            const results = await importFromUrls(manager, body.urls, enableOpt);
            const installed = results.filter((r) => r.ok).length;
            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, clientIp(req, cfg)),
                    action: 'import.url.batch',
                    requestId: req.id,
                    revision: manager.getRevision(),
                    outcome: installed > 0 ? 'success' : 'failure',
                    meta: {
                        total: results.length,
                        installed,
                        urls: body.urls.map((u) => redactUrl(u))
                    }
                });
            }
            const resp = {
                ok: true,
                installed,
                total: results.length,
                results: results.map(publicInstallResult),
                revision: manager.getRevision()
            };
            storeIdempotency(idemKey, 200, resp);
            return reply.code(200).send(resp);
        }

        // Single URL import
        if (typeof body.url === 'string' && body.url.trim()) {
            const query = req.query as Record<string, unknown> | undefined;
            const preferAsync =
                query?.async === 'true' ||
                req.headers['prefer'] === 'respond-async' ||
                req.headers['x-prefer-async'] === 'true';

            if (preferAsync && jobEngine) {
                const job = await jobEngine.enqueue(
                    'multi-addon-import',
                    { urls: [body.url.trim()], enable: body.enable },
                    {
                        idempotencyKey: idemKey,
                        requester: {
                            id: req.auth?.actor?.id,
                            ip: clientIp(req, cfg),
                            role: req.auth?.actor?.role
                        }
                    }
                );
                const resp = {
                    ok: true,
                    jobId: job.id,
                    status: job.status,
                    message: 'Import queued'
                };
                storeIdempotency(idemKey, 202, resp);
                return reply.code(202).send(resp);
            }

            const result = await importFromUrl(
                manager,
                body.url.trim(),
                enableOpt
            );
            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, clientIp(req, cfg)),
                    action: 'import.url',
                    target: result.addon?.providerId,
                    requestId: req.id,
                    revision: manager.getRevision(),
                    outcome: result.ok ? 'success' : 'failure',
                    reason: result.error,
                    meta: { url: redactUrl(body.url.trim()) }
                });
            }
            const resp = {
                ...publicInstallResult(result),
                revision: manager.getRevision()
            };
            const status = result.ok ? 200 : 400;
            storeIdempotency(idemKey, status, resp);
            return reply.code(status).send(resp);
        }

        return reply.code(400).send({
            error: {
                code: 'MISSING_PARAMETER',
                message: 'Provide { url } or { urls: string[] }'
            }
        });
    };

    app.post(
        '/v1/addons/import/url',
        { preHandler: adminGuard },
        handleImportUrl
    );
    app.post('/v1/import', { preHandler: adminGuard }, handleImportUrl);

    // ── import from Stremio account ─────────────────────────────────────────
    const handleImportStremio = async (
        req: FastifyRequest,
        reply: import('fastify').FastifyReply
    ) => {
        if (!(await gate(req, reply))) return;
        const idemKey = getIdempotencyKey(req);
        if (tryIdempotency(idemKey, reply)) return;

        const val = importStremioBodyValidator(req.body);
        if (!val.ok && val.errors) {
            return reply
                .code(400)
                .send(formatValidationError(val.errors, req.id));
        }
        const body = val.data!;

        if (jobEngine) {
            const job = await jobEngine.enqueue(
                'stremio-account-import',
                {
                    email: body.email,
                    password: body.password,
                    authKey: body.authKey,
                    endpoint: body.endpoint,
                    enable: body.enable
                },
                {
                    idempotencyKey: idemKey,
                    requester: {
                        id: req.auth?.actor?.id,
                        ip: clientIp(req, cfg),
                        role: req.auth?.actor?.role
                    }
                }
            );
            const resp = {
                ok: true,
                jobId: job.id,
                status: job.status,
                message: 'Stremio account import queued on durable job engine'
            };
            storeIdempotency(idemKey, 202, resp);
            return reply.code(202).send(resp);
        }

        try {
            // Credentials must never appear in logs/audit payloads.
            const result = await importFromStremioAccount(manager, {
                email: body.email,
                password: body.password,
                authKey: body.authKey,
                endpoint: body.endpoint
            });
            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, clientIp(req, cfg)),
                    action: 'import.stremio',
                    requestId: req.id,
                    revision: manager.getRevision(),
                    outcome: 'success',
                    meta: {
                        installed: result.installed,
                        total: result.total,
                        via: body.authKey ? 'authKey' : 'email'
                    }
                });
            }
            const resp = {
                ok: true,
                ...result,
                results: result.results?.map(publicInstallResult),
                revision: manager.getRevision()
            };
            storeIdempotency(idemKey, 200, resp);
            return reply.code(200).send(resp);
        } catch (err) {
            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, clientIp(req, cfg)),
                    action: 'import.stremio',
                    requestId: req.id,
                    outcome: 'failure',
                    reason: err instanceof Error ? err.message : 'Import failed'
                });
            }
            const resp = {
                ok: false,
                error: err instanceof Error ? err.message : 'Import failed'
            };
            storeIdempotency(idemKey, 400, resp);
            return reply.code(400).send(resp);
        }
    };

    app.post(
        '/v1/addons/import/stremio',
        { preHandler: adminGuard },
        handleImportStremio
    );
    app.post(
        '/v1/import/stremio',
        { preHandler: adminGuard },
        handleImportStremio
    );

    // ── import from repository (durable queue backed) ───────────────────────
    const handleImportRepo = async (
        req: FastifyRequest,
        reply: import('fastify').FastifyReply
    ) => {
        if (!(await gate(req, reply))) return;
        const idemKey = getIdempotencyKey(req);
        if (tryIdempotency(idemKey, reply)) return;

        const val = importRepoBodyValidator(req.body);
        if (!val.ok && val.errors) {
            return reply
                .code(400)
                .send(formatValidationError(val.errors, req.id));
        }
        const body = val.data!;
        const url = body.url.trim();

        if (jobEngine) {
            const job = await jobEngine.enqueue(
                'repository-import',
                { url, enable: body.enable },
                {
                    idempotencyKey: idemKey,
                    requester: {
                        id: req.auth?.actor?.id,
                        ip: clientIp(req, cfg),
                        role: req.auth?.actor?.role
                    }
                }
            );
            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, clientIp(req, cfg)),
                    action: 'import.repository.queued',
                    requestId: req.id,
                    target: job.id,
                    outcome: 'success',
                    meta: { url: redactUrl(url), jobId: job.id }
                });
            }
            const queuedResp = {
                ok: true,
                jobId: job.id,
                status: job.status,
                message: 'Repository import queued on durable job engine'
            };
            if (idemKey) {
                storeIdempotency(idemKey, 202, queuedResp);
            }
            return reply.code(202).send(queuedResp);
        }

        return reply.code(503).send({
            error: {
                code: 'JOB_ENGINE_UNAVAILABLE',
                message: 'Durable job engine is required for repository imports'
            }
        });
    };

    app.post(
        '/v1/addons/import/repository',
        { preHandler: adminGuard },
        handleImportRepo
    );
    app.post(
        '/v1/import/repository',
        { preHandler: adminGuard },
        handleImportRepo
    );

    // ── unified import jobs endpoints (durable query & cancel) ───────────────
    app.get<{ Params: { jobId: string } }>(
        '/v1/import/jobs/:jobId',
        { preHandler: adminGuard },
        async (req, reply) => {
            const paramVal = jobIdValidator(req.params.jobId);
            if (!paramVal.ok && paramVal.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramVal.errors, req.id));
            }
            if (!jobEngine) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            const job = await jobEngine.storage.getJob(paramVal.data!);
            if (!job) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            return reply.code(200).send({
                id: job.id,
                type: job.type,
                status: job.status,
                progress: job.progress,
                result: job.result,
                error: job.error,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt
            });
        }
    );

    app.delete<{ Params: { jobId: string } }>(
        '/v1/import/jobs/:jobId',
        { preHandler: adminGuard },
        async (req, reply) => {
            const paramVal = jobIdValidator(req.params.jobId);
            if (!paramVal.ok && paramVal.errors) {
                return reply
                    .code(400)
                    .send(formatValidationError(paramVal.errors, req.id));
            }
            if (!jobEngine) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            const job = await jobEngine.storage.getJob(paramVal.data!);
            if (!job) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            if (job.status === 'running' || job.status === 'queued') {
                await jobEngine.cancel(job.id);
                if (audit) {
                    await audit.record({
                        actor: actorFromAuth(
                            req.auth?.actor,
                            clientIp(req, cfg)
                        ),
                        action: 'import.job.cancel',
                        target: req.params.jobId,
                        requestId: req.id,
                        outcome: 'success'
                    });
                }
                const updated = await jobEngine.storage.getJob(job.id);
                return reply.code(200).send({ ok: true, job: updated });
            }
            return reply.code(409).send({
                error: {
                    code: 'CONFLICT',
                    message: `Job already ${job.status}`
                }
            });
        }
    );

    app.get(
        '/v1/import/jobs',
        { preHandler: adminGuard },
        async (_req, reply) => {
            if (!jobEngine) {
                return reply.code(200).send({ jobs: [] });
            }
            const jobs = await jobEngine.storage.listJobs({ limit: 50 });
            return reply.code(200).send({
                jobs: jobs.map((j) => ({
                    id: j.id,
                    type: j.type,
                    status: j.status,
                    progress: j.progress,
                    result: j.result,
                    error: j.error,
                    createdAt: j.createdAt,
                    startedAt: j.startedAt,
                    finishedAt: j.finishedAt
                }))
            });
        }
    );
}
