import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { JobEngine } from '../jobs/engine.js';
import type { IStorageBackend, JobStatus } from '../storage/types.js';
import {
    createRateLimiter,
    RATE_LIMITS,
    rateLimitKey
} from '../security/rateLimit.js';
import { actorFromAuth, type AuditLogger } from '../security/audit.js';
import { getRateLimitIp } from '../security/auth.js';
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

export function registerJobRoutes(
    app: FastifyInstance,
    jobEngine: JobEngine,
    storage: IStorageBackend,
    cfg: AppConfig,
    audit?: AuditLogger
): void {
    const operatorGuard = makeAuthGuard(cfg, { role: 'operator' });
    const limiter = createRateLimiter();

    // List jobs
    app.get<{
        Querystring: {
            type?: string;
            status?: string;
            limit?: string;
            offset?: string;
        };
    }>('/v1/jobs', { preHandler: operatorGuard }, async (req, reply) => {
        const { type, status, limit, offset } = req.query;
        const lim = Math.min(100, Math.max(1, Number(limit) || 50));
        const off = Math.max(0, Number(offset) || 0);

        const jobs = await storage.listJobs({
            type: type?.trim() || undefined,
            status: status ? (status.trim() as JobStatus) : undefined,
            limit: lim,
            offset: off
        });

        return reply.code(200).send({
            jobs,
            limit: lim,
            offset: off
        });
    });

    // Inspect single job
    app.get<{ Params: { id: string } }>(
        '/v1/jobs/:id',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const job = await storage.getJob(req.params.id);
            if (!job) {
                return reply.code(404).send({
                    error: { code: 'NOT_FOUND', message: 'Job not found' }
                });
            }
            return reply.code(200).send({ job });
        }
    );

    // Enqueue job
    app.post<{
        Body: {
            type: string;
            payload?: Record<string, unknown>;
            priority?: number;
            idempotencyKey?: string;
            dedupKey?: string;
        };
    }>('/v1/jobs', { preHandler: operatorGuard }, async (req, reply) => {
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

        const { type, payload, priority, idempotencyKey, dedupKey } =
            req.body ?? {};
        if (!type || typeof type !== 'string') {
            return reply.code(400).send({
                error: {
                    code: 'MISSING_PARAMETER',
                    message: "Field 'type' is required"
                }
            });
        }

        if (!jobEngine.hasHandler(type)) {
            return reply.code(400).send({
                error: {
                    code: 'UNKNOWN_JOB_TYPE',
                    message: `Unknown or unsupported job type '${type}'. Available types: ${jobEngine.getRegisteredTypes().join(', ')}`
                }
            });
        }

        const job = await jobEngine.enqueue(type, payload || {}, {
            priority,
            idempotencyKey,
            dedupKey,
            requester: {
                id: req.auth?.actor?.id,
                ip,
                role: req.auth?.actor?.role
            }
        });

        if (audit) {
            await audit.record({
                actor: actorFromAuth(req.auth?.actor, ip),
                action: 'job.enqueue',
                target: job.id,
                requestId: req.id,
                outcome: 'success',
                meta: { type, jobId: job.id }
            });
        }

        return reply.code(202).send({
            ok: true,
            job
        });
    });

    // Cancel job
    app.post<{ Params: { id: string } }>(
        '/v1/jobs/:id/cancel',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            const { id } = req.params;
            const cancelled = await jobEngine.cancel(id);
            if (!cancelled) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Job not found or already completed'
                    }
                });
            }

            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, ip),
                    action: 'job.cancel',
                    target: id,
                    requestId: req.id,
                    outcome: 'success'
                });
            }

            const job = await storage.getJob(id);
            return reply.code(200).send({
                ok: true,
                job
            });
        }
    );

    // Retry job
    app.post<{ Params: { id: string } }>(
        '/v1/jobs/:id/retry',
        { preHandler: operatorGuard },
        async (req, reply) => {
            const ip = clientIp(req, cfg);
            const { id } = req.params;
            const job = await jobEngine.retry(id);
            if (!job) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Job not found'
                    }
                });
            }

            if (audit) {
                await audit.record({
                    actor: actorFromAuth(req.auth?.actor, ip),
                    action: 'job.retry',
                    target: id,
                    requestId: req.id,
                    outcome: 'success',
                    meta: { newJobId: job.id }
                });
            }

            return reply.code(200).send({
                ok: true,
                job
            });
        }
    );
}
