/**
 * Auth route helpers + session login endpoint registration.
 *
 * Management guards live in `src/security/auth.ts`. This module re-exports
 * them for existing import paths and adds the admin session login/logout API
 * so the UI never needs long-lived tokens in localStorage.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import {
    makeAuthGuard,
    makeAdminGuard,
    resolveActor,
    signSession,
    safeEqual,
    SESSION_COOKIE,
    type Role
} from '../security/auth.js';
import {
    buildSessionCookie,
    clearSessionCookie
} from '../security/httpSecurity.js';
import {
    generateCsrfToken,
    buildCsrfCookie,
    clearCsrfCookie
} from '../security/csrf.js';
import {
    createRateLimiter,
    RATE_LIMITS,
    rateLimitKey
} from '../security/rateLimit.js';
import type { AuditLogger } from '../security/audit.js';
import { actorFromAuth } from '../security/audit.js';
import { getRateLimitIp } from '../security/auth.js';

export { makeAuthGuard, makeAdminGuard };

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

/**
 * Register:
 *   POST /v1/auth/login    { token } → sets HttpOnly session cookie
 *   POST /v1/auth/logout             → clears session cookie
 *   GET  /v1/auth/me                 → current actor (or 401)
 */
export function registerAuthRoutes(
    app: FastifyInstance,
    cfg: AppConfig,
    audit?: AuditLogger
): void {
    const limiter = createRateLimiter();
    const secure =
        cfg.nodeEnv === 'production' ||
        Boolean(cfg.publicUrl?.startsWith('https:'));
    const sessionSecret =
        cfg.authSessionSecret || cfg.adminToken || cfg.serviceJwtSecret;

    app.post<{ Body: { token?: string; role?: string } }>(
        '/v1/auth/login',
        async (request, reply) => {
            const ip = clientIp(request, cfg);
            const rl = limiter.take(
                rateLimitKey('auth', undefined, ip),
                RATE_LIMITS.auth.limit,
                RATE_LIMITS.auth.windowMs
            );
            if (!rl.allowed) {
                reply.header('Retry-After', String(rl.retryAfterSec));
                return reply.code(429).send({
                    error: {
                        code: 'RATE_LIMITED',
                        message: 'Too many login attempts'
                    }
                });
            }

            if (cfg.authMode === 'disabled') {
                // Local dev: issue a session without a token so the UI can
                // still use cookie-based calls consistently.
                if (!sessionSecret) {
                    return reply.code(200).send({
                        ok: true,
                        actor: {
                            id: 'local-dev',
                            role: 'admin',
                            method: 'none'
                        },
                        authMode: cfg.authMode
                    });
                }
                const { token, expiresAt } = signSession(
                    {
                        sub: 'local-dev',
                        role: 'admin',
                        ttlSec: cfg.sessionTtlSec
                    },
                    sessionSecret
                );
                const csrf = generateCsrfToken();
                reply.header('Set-Cookie', [
                    buildSessionCookie(SESSION_COOKIE, token, {
                        expires: expiresAt,
                        secure
                    }),
                    buildCsrfCookie(csrf, secure)
                ]);
                return reply.code(200).send({
                    ok: true,
                    actor: {
                        id: 'local-dev',
                        role: 'admin',
                        method: 'session'
                    },
                    authMode: cfg.authMode,
                    expiresAt: expiresAt.toISOString(),
                    csrfToken: csrf
                });
            }

            if (cfg.authMode === 'static-token') {
                const provided = (request.body?.token ?? '').trim();
                if (
                    !cfg.adminToken ||
                    !provided ||
                    !safeEqual(provided, cfg.adminToken)
                ) {
                    if (audit) {
                        await audit.record({
                            actor: actorFromAuth(undefined, ip),
                            action: 'auth.login',
                            outcome: 'denied',
                            reason: 'invalid token',
                            requestId: request.id
                        });
                    }
                    return reply.code(401).send({
                        error: {
                            code: 'UNAUTHORIZED',
                            message: 'Invalid admin token'
                        }
                    });
                }
                if (!sessionSecret) {
                    return reply.code(500).send({
                        error: {
                            code: 'MISCONFIGURED',
                            message: 'Session secret is not configured'
                        }
                    });
                }
                const role: Role = cfg.adminTokenRole;
                const { token, expiresAt } = signSession(
                    { sub: 'admin-token', role, ttlSec: cfg.sessionTtlSec },
                    sessionSecret
                );
                const csrf = generateCsrfToken();
                reply.header('Set-Cookie', [
                    buildSessionCookie(SESSION_COOKIE, token, {
                        expires: expiresAt,
                        secure
                    }),
                    buildCsrfCookie(csrf, secure)
                ]);
                if (audit) {
                    await audit.record({
                        actor: {
                            id: 'admin-token',
                            role,
                            method: 'session',
                            ip
                        },
                        action: 'auth.login',
                        outcome: 'success',
                        requestId: request.id
                    });
                }
                return reply.code(200).send({
                    ok: true,
                    actor: { id: 'admin-token', role, method: 'session' },
                    authMode: cfg.authMode,
                    expiresAt: expiresAt.toISOString(),
                    csrfToken: csrf
                });
            }

            // reverse-proxy / service-jwt: identity already comes from headers;
            // optionally mint a session so subsequent browser calls work.
            const actor = resolveActor(request, cfg);
            if (!actor) {
                return reply.code(401).send({
                    error: {
                        code: 'UNAUTHORIZED',
                        message: 'Authentication required'
                    }
                });
            }
            if (sessionSecret) {
                const { token, expiresAt } = signSession(
                    {
                        sub: actor.id,
                        role: actor.role,
                        ttlSec: cfg.sessionTtlSec
                    },
                    sessionSecret
                );
                const csrf = generateCsrfToken();
                reply.header('Set-Cookie', [
                    buildSessionCookie(SESSION_COOKIE, token, {
                        expires: expiresAt,
                        secure
                    }),
                    buildCsrfCookie(csrf, secure)
                ]);
                return reply.code(200).send({
                    ok: true,
                    actor: {
                        id: actor.id,
                        role: actor.role,
                        method: 'session'
                    },
                    authMode: cfg.authMode,
                    expiresAt: expiresAt.toISOString(),
                    csrfToken: csrf
                });
            }
            return reply.code(200).send({
                ok: true,
                actor: {
                    id: actor.id,
                    role: actor.role,
                    method: actor.method
                },
                authMode: cfg.authMode
            });
        }
    );

    app.post('/v1/auth/logout', async (request, reply) => {
        reply.header('Set-Cookie', [
            clearSessionCookie(SESSION_COOKIE, { secure }),
            clearCsrfCookie(secure)
        ]);
        if (audit) {
            const actor = resolveActor(request, cfg) ?? undefined;
            await audit.record({
                actor: actorFromAuth(actor, clientIp(request, cfg)),
                action: 'auth.logout',
                outcome: 'success',
                requestId: request.id
            });
        }
        return reply.code(200).send({ ok: true });
    });

    app.get('/v1/auth/me', async (request, reply) => {
        const actor = resolveActor(request, cfg);
        if (!actor) {
            return reply.code(401).send({
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Not authenticated'
                }
            });
        }
        return reply.code(200).send({
            actor: {
                id: actor.id,
                role: actor.role,
                method: actor.method
            },
            authMode: cfg.authMode
        });
    });

    app.get('/v1/auth/csrf', async (request, reply) => {
        const actor = resolveActor(request, cfg);
        if (!actor) {
            return reply.code(401).send({
                error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }
            });
        }
        const cookies =
            (request as FastifyRequest & { cookies?: Record<string, string> })
                .cookies ?? {};
        let token = cookies['csrf_token'];
        if (!token) {
            token = generateCsrfToken();
            reply.header('Set-Cookie', buildCsrfCookie(token, secure));
        }
        return reply.code(200).send({ csrfToken: token });
    });
}

/** Helper used by mutation routes to enforce rate limits uniformly. */
export async function enforceRateLimit(
    reply: FastifyReply,
    limiter: ReturnType<typeof createRateLimiter>,
    key: string,
    limit: number,
    windowMs: number
): Promise<boolean> {
    const result = limiter.take(key, limit, windowMs);
    reply.header('X-RateLimit-Limit', String(result.limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
        reply.header('Retry-After', String(result.retryAfterSec));
        await reply.code(429).send({
            error: {
                code: 'RATE_LIMITED',
                message: 'Too many requests — try again shortly'
            }
        });
        return false;
    }
    return true;
}
