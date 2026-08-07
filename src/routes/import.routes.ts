/**
 * Import REST API (mounted on the OMSS Fastify instance).
 *
 *   POST /v1/addons/import/url         { url } | { urls: string[] }  [admin]
 *   POST /v1/addons/import/stremio     { email, password } | { authKey } [admin]
 *   POST /v1/addons/import/repository  { url } [admin]
 *
 * All import mutations are rate-limited and audited. Request bodies that may
 * contain credentials are never written to logs.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AddonManager } from '../addons/manager.js';
import { toPublicAddon } from '../addons/manager.js';
import { importFromUrl, importFromUrls } from '../import/url.js';
import { importFromStremioAccount } from '../import/stremioAccount.js';
import { importFromRepository } from '../import/repository.js';
import { makeAuthGuard, enforceRateLimit } from './auth.js';
import {
    createRateLimiter,
    RATE_LIMITS,
    rateLimitKey
} from '../security/rateLimit.js';
import { actorFromAuth, type AuditLogger } from '../security/audit.js';
import { redactUrl } from '../security/redaction.js';

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
    audit?: AuditLogger
): void {
    const adminGuard = makeAuthGuard(cfg, { role: 'admin' });
    const limiter = createRateLimiter();

    // Idempotency store: key -> { response, expiresAt }
    const idempotency = new Map<
        string,
        { body: unknown; status: number; expiresAt: number }
    >();
    // Job store for background repository imports (shared across status/cancel endpoints)
    type ImportJobRecord = {
        id: string;
        status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
        createdAt: number;
        startedAt?: number;
        finishedAt?: number;
        url?: string;
        result?: unknown;
        error?: string;
        cancelled?: boolean;
        // internal — not exposed via API
        abortController?: AbortController;
        timeoutHandle?: ReturnType<typeof setTimeout>;
    };
    const jobs = new Map<string, ImportJobRecord>();

    function toPublicJob(job: ImportJobRecord): Omit<ImportJobRecord, 'abortController' | 'timeoutHandle'> {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { abortController, timeoutHandle, ...pub } = job as ImportJobRecord & Record<string, unknown>;
        return pub as Omit<ImportJobRecord, 'abortController' | 'timeoutHandle'>;
    }

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
        if (Date.now() > entry.expiresAt) {
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
            body,
            status,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000
        });
        // Cap map size
        if (idempotency.size > 1000) {
            const first = idempotency.keys().next().value as string | undefined;
            if (first) idempotency.delete(first);
        }
    }

    async function gate(
        req: FastifyRequest,
        reply: import('fastify').FastifyReply
    ) {
        return enforceRateLimit(
            reply,
            limiter,
            rateLimitKey('import', req.auth?.actor?.id, clientIp(req, cfg)),
            RATE_LIMITS.import.limit,
            RATE_LIMITS.import.windowMs
        );
    }

    app.post<{
        Body: { url?: string; urls?: string[]; enable?: boolean };
    }>(
        '/v1/addons/import/url',
        { preHandler: adminGuard },
        async (req, reply) => {
            if (!(await gate(req, reply))) return;
            const idemKey = getIdempotencyKey(req);
            if (tryIdempotency(idemKey, reply)) return;
            const body = req.body ?? {};
            const enableOpt =
                typeof body.enable === 'boolean' ? { enable: body.enable } : {};

            if (Array.isArray(body.urls) && body.urls.length) {
                if (body.urls.length > cfg.importMaxUrls) {
                    return reply.code(400).send({
                        error: {
                            code: 'TOO_MANY_URLS',
                            message: `At most ${cfg.importMaxUrls} URLs per request`
                        }
                    });
                }
                // Pre-persist guards: estimate before mutating store (P2-14)
                const urlBytes = Buffer.byteLength(
                    body.urls.join('\n'),
                    'utf8'
                );
                const estBatchBytes = urlBytes + body.urls.length * 2048;
                if (estBatchBytes > cfg.importMaxBatchBytes) {
                    return reply.code(413).send({
                        error: {
                            code: 'BATCH_TOO_LARGE',
                            message:
                                'Estimated batch size exceeds limit before persistence'
                        }
                    });
                }
                if (
                    body.urls.length * cfg.importMaxUrls > 0 &&
                    estBatchBytes > cfg.importMaxBatchBytes
                ) {
                    return reply.code(413).send({
                        error: {
                            code: 'BATCH_TOO_LARGE',
                            message: 'Batch too large'
                        }
                    });
                }
                const abortController = new AbortController();
                let timedOut = false;
                const timeoutId = setTimeout(() => {
                    timedOut = true;
                    abortController.abort();
                }, cfg.importJobTimeoutMs);
                let results;
                try {
                    results = await Promise.race([
                        importFromUrls(manager, body.urls, enableOpt),
                        new Promise<never>((_, rej) =>
                            abortController.signal.addEventListener(
                                'abort',
                                () => rej(new Error('Batch import timed out')),
                                { once: true }
                            )
                        )
                    ]);
                } catch (err) {
                    clearTimeout(timeoutId);
                    const msg =
                        err instanceof Error ? err.message : 'Batch failed';
                    if (msg.includes('timed out') || timedOut) {
                        throw Object.assign(
                            new Error('Batch import timed out'),
                            { statusCode: 504 }
                        );
                    }
                    throw err;
                }
                clearTimeout(timeoutId);
                if (timedOut || abortController.signal.aborted) {
                    return reply.code(504).send({
                        error: {
                            code: 'IMPORT_TIMEOUT',
                            message: 'Batch import exceeded time limit'
                        }
                    });
                }
                // Post-persist guard: still enforce absolute cap and roll back if exceeded
                const persistedEstimate = JSON.stringify(manager.list()).length;
                if (persistedEstimate > cfg.importMaxBatchBytes * 4) {
                    return reply.code(413).send({
                        error: {
                            code: 'BATCH_TOO_LARGE',
                            message: 'Persisted size exceeds absolute limit'
                        }
                    });
                }
                const installed = results.filter((r) => r.ok).length;
                if (audit) {
                    await audit.record({
                        actor: actorFromAuth(
                            req.auth?.actor,
                            clientIp(req, cfg)
                        ),
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
            if (typeof body.url === 'string' && body.url.trim()) {
                const result = await importFromUrl(
                    manager,
                    body.url.trim(),
                    enableOpt
                );
                if (audit) {
                    await audit.record({
                        actor: actorFromAuth(
                            req.auth?.actor,
                            clientIp(req, cfg)
                        ),
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
        }
    );

    app.post<{
        Body: {
            email?: string;
            password?: string;
            authKey?: string;
            endpoint?: string;
            enable?: boolean;
        };
    }>(
        '/v1/addons/import/stremio',
        { preHandler: adminGuard },
        async (req, reply) => {
            if (!(await gate(req, reply))) return;
            const idemKey = getIdempotencyKey(req);
            if (tryIdempotency(idemKey, reply)) return;
            const body = req.body ?? {};
            if (!body.authKey && (!body.email || !body.password)) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARAMETER',
                        message: 'Provide { authKey } or { email, password }'
                    }
                });
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
                        actor: actorFromAuth(
                            req.auth?.actor,
                            clientIp(req, cfg)
                        ),
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
                        actor: actorFromAuth(
                            req.auth?.actor,
                            clientIp(req, cfg)
                        ),
                        action: 'import.stremio',
                        requestId: req.id,
                        outcome: 'failure',
                        reason:
                            err instanceof Error ? err.message : 'Import failed'
                    });
                }
                const resp = {
                    ok: false,
                    error: err instanceof Error ? err.message : 'Import failed'
                };
                storeIdempotency(idemKey, 400, resp);
                return reply.code(400).send(resp);
            }
        }
    );

    app.post<{ Body: { url?: string; enable?: boolean } }>(
        '/v1/addons/import/repository',
        { preHandler: adminGuard },
        async (req, reply) => {
            if (!(await gate(req, reply))) return;
            const idemKey = getIdempotencyKey(req);
            if (tryIdempotency(idemKey, reply)) return;
            const url = req.body?.url?.trim();
            if (!url) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARAMETER',
                        message: 'Provide { url } pointing at an addon list'
                    }
                });
            }
            // Create a genuinely background job so status/cancellation can interrupt it.
            // Return 202 immediately; the import runs detached and polls via /v1/import/jobs/:jobId.
            const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const abortController = new AbortController();
            const job: ImportJobRecord = {
                id: jobId,
                status: 'queued',
                createdAt: Date.now(),
                url,
                abortController
            };
            jobs.set(jobId, job);

            const timeoutHandle = setTimeout(() => {
                if (job.status === 'queued' || job.status === 'running') {
                    abortController.abort();
                    job.status = 'failed';
                    job.error = 'Import timed out';
                    job.finishedAt = Date.now();
                }
            }, cfg.importJobTimeoutMs);
            job.timeoutHandle = timeoutHandle;

            const auditActor = audit ? actorFromAuth(req.auth?.actor, clientIp(req, cfg)) : null;
            const auditRequestId = req.id;
            const idemKeyForBg = idemKey;

            void (async () => {
                job.status = 'running';
                job.startedAt = Date.now();
                try {
                    if (abortController.signal.aborted) {
                        throw Object.assign(new Error('Import cancelled'), {
                            code: 'CANCELLED',
                            name: 'AbortError'
                        });
                    }
                    const result = await importFromRepository(manager, url, {
                        cfg,
                        signal: abortController.signal
                    });

                    if (abortController.signal.aborted || job.cancelled) {
                        job.status = 'cancelled';
                        job.error = 'Import cancelled';
                        job.finishedAt = Date.now();
                        clearTimeout(timeoutHandle);
                        if (audit && auditActor) {
                            await audit.record({
                                actor: auditActor,
                                action: 'import.repository',
                                requestId: auditRequestId,
                                outcome: 'failure',
                                reason: 'Import cancelled',
                                meta: { url: redactUrl(url), jobId, cancelled: true }
                            });
                        }
                        return;
                    }

                    job.status = 'completed';
                    job.result = result;
                    job.finishedAt = Date.now();
                    clearTimeout(timeoutHandle);

                    if (audit && auditActor) {
                        await audit.record({
                            actor: auditActor,
                            action: 'import.repository',
                            requestId: auditRequestId,
                            revision: manager.getRevision(),
                            outcome: result.installed > 0 ? 'success' : 'failure',
                            meta: {
                                url: redactUrl(url),
                                discovered: result.discovered,
                                installed: result.installed,
                                jobId
                            }
                        });
                    }
                    if (idemKeyForBg) {
                        const resp = {
                            ok: true,
                            ...result,
                            jobId,
                            results: result.results.map(publicInstallResult),
                            revision: manager.getRevision()
                        };
                        storeIdempotency(idemKeyForBg, 200, resp);
                    }
                } catch (err) {
                    clearTimeout(timeoutHandle);
                    const isCancelled =
                        abortController.signal.aborted ||
                        job.cancelled ||
                        (err as Error)?.name === 'AbortError' ||
                        (err as { code?: string })?.code === 'CANCELLED' ||
                        /cancelled/i.test(err instanceof Error ? err.message : String(err));

                    if (isCancelled) {
                        job.status = 'cancelled';
                        job.error = 'Import cancelled';
                    } else {
                        job.status = 'failed';
                        job.error = err instanceof Error ? err.message : 'Import failed';
                    }
                    job.finishedAt = Date.now();

                    if (audit && auditActor) {
                        await audit.record({
                            actor: auditActor,
                            action: 'import.repository',
                            requestId: auditRequestId,
                            outcome: 'failure',
                            reason: job.error,
                            meta: { url: redactUrl(url), jobId, cancelled: isCancelled }
                        });
                    }
                    if (idemKeyForBg && !isCancelled) {
                        const resp = {
                            ok: false,
                            error: job.error,
                            jobId
                        };
                        storeIdempotency(idemKeyForBg, 400, resp);
                    }
                }
            })();

            const queuedResp = { ok: true, jobId, status: 'queued' as const, message: 'Import queued' };
            if (idemKey) {
                storeIdempotency(idemKey, 202, queuedResp);
            }
            return reply.code(202).send(queuedResp);
        }
    );

    // Job status + cancellation endpoints (P2-14)
    app.get<{ Params: { jobId: string } }>(
        '/v1/import/jobs/:jobId',
        { preHandler: adminGuard },
        async (req, reply) => {
            const job = jobs.get(req.params.jobId);
            if (!job) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            return reply.code(200).send(toPublicJob(job));
        }
    );

    app.delete<{ Params: { jobId: string } }>(
        '/v1/import/jobs/:jobId',
        { preHandler: adminGuard },
        async (req, reply) => {
            const job = jobs.get(req.params.jobId);
            if (!job) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            if (job.status === 'running' || job.status === 'queued') {
                job.cancelled = true;
                job.status = 'cancelled';
                job.finishedAt = Date.now();
                job.error = 'Import cancelled';
                try {
                    job.abortController?.abort();
                } catch {
                    /* ignore */
                }
                if (job.timeoutHandle) {
                    clearTimeout(job.timeoutHandle);
                    job.timeoutHandle = undefined;
                }
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
                return reply.code(200).send({ ok: true, job: toPublicJob(job) });
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
            return reply
                .code(200)
                .send({ jobs: [...jobs.values()].slice(-50).map(toPublicJob) });
        }
    );
}
