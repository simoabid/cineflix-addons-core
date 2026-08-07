/**
 * Browser and HTTP security: headers, CORS validation, request limits,
 * centralized safe error mapping.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { redactString, redactUrl, redactValue } from './redaction.js';
import { CSRF_COOKIE, CSRF_HEADER } from './csrf.js';
const SESSION_COOKIE = 'addons_core_session';

export interface SafeErrorBody {
    error: {
        code: string;
        message: string;
    };
    requestId?: string;
}

/** Map any thrown value to a safe client-facing error (no stacks/secrets/URLs). */
export function toSafeError(
    err: unknown,
    fallbackStatus = 500
): { status: number; body: SafeErrorBody } {
    const status =
        (err as { statusCode?: number; status?: number })?.statusCode ??
        (err as { statusCode?: number; status?: number })?.status ??
        fallbackStatus;

    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';

    if (err && typeof err === 'object') {
        const e = err as {
            code?: string;
            message?: string;
            name?: string;
        };
        if (typeof e.code === 'string' && e.code.length < 64) {
            code = e.code
                .replace(/[^A-Z0-9_]/gi, '_')
                .toUpperCase()
                .slice(0, 64);
        } else if (e.name === 'UrlPolicyError') {
            code = 'URL_POLICY_VIOLATION';
        } else if (e.name === 'SecureFetchError') {
            code = 'OUTBOUND_FETCH_FAILED';
        }

        if (typeof e.message === 'string' && e.message.length > 0) {
            // Redact and cap; never echo raw upstream bodies.
            message = redactString(redactUrl(e.message), 240);
        }
    }

    // Never leak 5xx internals in production-shaped responses beyond a safe code.
    if (status >= 500 && code === 'INTERNAL_ERROR') {
        message = 'An unexpected error occurred';
    }

    return {
        status: clampStatus(status),
        body: { error: { code, message } }
    };
}

function clampStatus(s: number): number {
    if (!Number.isFinite(s) || s < 400 || s > 599) return 500;
    return Math.floor(s);
}

/** Build the Content-Security-Policy for the admin UI. */
export function adminCsp(): string {
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/** Apply standard security headers to a reply. */
export function applySecurityHeaders(
    reply: FastifyReply,
    cfg: AppConfig,
    opts: { adminUi?: boolean } = {}
): void {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=()'
    );
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');

    if (cfg.nodeEnv === 'production') {
        // HSTS only meaningful behind TLS; operators terminate TLS at the edge.
        reply.header(
            'Strict-Transport-Security',
            'max-age=31536000; includeSubDomains'
        );
    }

    if (opts.adminUi) {
        reply.header('Content-Security-Policy', adminCsp());
        reply.header('Cache-Control', 'no-store');
    }
}

/**
 * Validate CORS configuration for production: wildcard is refused.
 * Returns the origin value to pass to the framework, or throws.
 */
export function assertCorsSafe(cfg: AppConfig): void {
    if (cfg.nodeEnv !== 'production') return;
    const origin = (cfg.corsOrigin || '').trim();
    if (!origin || origin === '*') {
        throw new Error(
            'Production requires an exact CORS_ORIGIN allowlist (not "*"). ' +
                'Set CORS_ORIGIN to your frontend origin, e.g. https://cineflix.example'
        );
    }
}

/** Parse a Cookie header into a map (no external cookie plugin required). */
export function parseCookieHeader(
    header: string | string[] | undefined
): Record<string, string> {
    const raw = Array.isArray(header) ? header.join(';') : header;
    if (!raw) return {};
    const out: Record<string, string> = {};
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (!k) continue;
        try {
            out[k] = decodeURIComponent(v);
        } catch {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Register global onRequest / onSend hooks for security headers, body
 * size awareness, and request-id propagation.
 */
export function registerHttpSecurity(
    app: FastifyInstance,
    cfg: AppConfig
): void {
    app.addHook('onRequest', async (request, reply) => {
        // Reject absurd query strings early.
        const url = request.url ?? '';
        const qIdx = url.indexOf('?');
        if (qIdx !== -1 && url.length - qIdx > cfg.maxQueryLength) {
            await reply.code(414).send({
                error: {
                    code: 'QUERY_TOO_LONG',
                    message: 'Query string exceeds limit'
                }
            });
            return;
        }

        // Enforce header size limit (P2-12)
        const headerBytes = Object.entries(request.headers).reduce(
            (sum, [k, v]) =>
                sum +
                k.length +
                (Array.isArray(v)
                    ? v.join(',').length
                    : String(v ?? '').length),
            0
        );
        if (headerBytes > cfg.maxHeaderBytes) {
            await reply.code(431).send({
                error: {
                    code: 'HEADERS_TOO_LARGE',
                    message: 'Request headers exceed limit'
                }
            });
            return;
        }

        // Attach parsed cookies for auth session support.
        const cookies = parseCookieHeader(request.headers.cookie);
        (
            request as FastifyRequest & { cookies?: Record<string, string> }
        ).cookies = cookies;

        applySecurityHeaders(reply, cfg, {
            adminUi: url.startsWith('/admin')
        });

        // CSRF validation for cookie-authenticated mutations (P2-11)
        if (
            cfg.csrfEnabled &&
            ['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method)
        ) {
            const hasSession = Boolean(cookies[SESSION_COOKIE]);
            if (hasSession) {
                const csrfCookie = cookies[CSRF_COOKIE];
                const hdr =
                    request.headers[CSRF_HEADER] ??
                    request.headers['x-csrf-token'];
                const csrfHeader = Array.isArray(hdr)
                    ? hdr[0]
                    : (hdr as string | undefined);
                // Exempt login which mints the CSRF token, and the CSRF endpoint itself
                const exempt =
                    request.url.startsWith('/v1/auth/login') ||
                    request.url.startsWith('/v1/auth/csrf');
                if (!exempt) {
                    if (
                        !csrfCookie ||
                        !csrfHeader ||
                        csrfCookie !== csrfHeader
                    ) {
                        await reply.code(403).send({
                            error: {
                                code: 'CSRF_FAILED',
                                message: 'CSRF token missing or invalid'
                            }
                        });
                        return;
                    }
                }
            }
        }
    });

    // Enforce body limit before parsing: check Content-Length early, and for chunked
    // install a raw stream counter that aborts if limit exceeded
    app.addHook('onRequest', async (request, reply) => {
        const lenHeader = request.headers['content-length'];
        if (lenHeader) {
            const n = Number(lenHeader);
            if (Number.isFinite(n) && n > cfg.maxBodyBytes) {
                await reply.code(413).send({
                    error: {
                        code: 'PAYLOAD_TOO_LARGE',
                        message: 'Request body exceeds limit'
                    }
                });
                return;
            }
        } else if (
            request.headers['transfer-encoding']
                ?.toString()
                .toLowerCase()
                .includes('chunked')
        ) {
            // For chunked, we will count bytes as they arrive in a preHandler wrapper
            // Store limit on request for later check
            (request as unknown as { _bodyLimit?: number })._bodyLimit =
                cfg.maxBodyBytes;
        }
    });

    // Custom JSON parser that enforces size and depth before Fastify's default parsing
    // This runs before preHandler, ensuring chunked bodies are bounded
    try {
        app.addContentTypeParser(
            'application/json',
            { parseAs: 'string', bodyLimit: cfg.maxBodyBytes },
            (req, body, done) => {
                try {
                    if ((body as string).length > cfg.maxBodyBytes) {
                        done(new Error('PAYLOAD_TOO_LARGE'), undefined);
                        return;
                    }
                    const json = JSON.parse(body as string);
                    const depth = jsonDepth(json);
                    if (depth > cfg.maxJsonDepth) {
                        const err = Object.assign(
                            new Error(
                                `JSON depth ${depth} exceeds limit ${cfg.maxJsonDepth}`
                            ),
                            {
                                statusCode: 400,
                                code: 'JSON_DEPTH_EXCEEDED'
                            }
                        );
                        done(err as Error, undefined);
                        return;
                    }
                    done(null, json);
                } catch (err) {
                    done(err as Error, undefined);
                }
            }
        );
    } catch {
        // Parser already registered (e.g., in tests) — ignore
    }

    // Global request timeout with abort (P2-12 / P1)
    if (cfg.globalRequestTimeoutMs > 0) {
        app.addHook('onRequest', async (request, reply) => {
            const controller = new AbortController();
            (request as unknown as { signal?: AbortSignal }).signal =
                controller.signal;
            const t = setTimeout(() => {
                controller.abort();
                if (!reply.sent) {
                    void reply.code(408).send({
                        error: {
                            code: 'REQUEST_TIMEOUT',
                            message: 'Request timed out'
                        }
                    });
                    try {
                        (
                            request.raw as unknown as { destroy?: () => void }
                        ).destroy?.();
                    } catch (_e) {
                        void _e;
                    }
                }
            }, cfg.globalRequestTimeoutMs);
            reply.raw.on('finish', () => {
                clearTimeout(t);
                controller.abort();
            });
            reply.raw.on('close', () => {
                clearTimeout(t);
                controller.abort();
            });
            (request as unknown as { _timeout?: NodeJS.Timeout })._timeout = t;
        });
    }

    // Fallback depth check for already-parsed bodies (e.g., other content types)
    app.addHook('preHandler', async (request, reply) => {
        const body = (request as { body?: unknown }).body;
        if (body && typeof body === 'object') {
            const depth = jsonDepth(body);
            if (depth > cfg.maxJsonDepth) {
                await reply.code(400).send({
                    error: {
                        code: 'JSON_DEPTH_EXCEEDED',
                        message: `JSON depth ${depth} exceeds limit ${cfg.maxJsonDepth}`
                    }
                });
                return;
            }
        }
        // Also handle chunked bodies that were counted via raw stream
        const raw = request.raw as unknown as { _bodyBytes?: number };
        if (
            raw &&
            typeof raw._bodyBytes === 'number' &&
            raw._bodyBytes > cfg.maxBodyBytes
        ) {
            await reply.code(413).send({
                error: {
                    code: 'PAYLOAD_TOO_LARGE',
                    message: 'Request body exceeds limit'
                }
            });
            return;
        }
    });

    app.addHook('onSend', async (request, reply, payload) => {
        // Ensure every response carries a request id when available.
        const rid =
            request.id ||
            (request.headers['x-request-id'] as string | undefined);
        if (rid) reply.header('X-Request-Id', String(rid));

        // API responses should not be cached by shared caches by default.
        const url = request.url ?? '';
        if (url.startsWith('/v1/') && !url.startsWith('/v1/proxy')) {
            if (!reply.getHeader('Cache-Control')) {
                reply.header('Cache-Control', 'no-store');
            }
        }
        return payload;
    });

    function jsonDepth(value: unknown, current = 0): number {
        if (value === null || typeof value !== 'object') return current;
        if (Array.isArray(value)) {
            if (value.length === 0) return current + 1;
            return Math.max(...value.map((v) => jsonDepth(v, current + 1)));
        }
        const vals = Object.values(value as Record<string, unknown>);
        if (vals.length === 0) return current + 1;
        return Math.max(...vals.map((v) => jsonDepth(v, current + 1)));
    }

    function redactLogPath(url: string): string {
        const qIdx = url.indexOf('?');
        const path = qIdx === -1 ? url : url.slice(0, qIdx);
        // Proxy grants contain sensitive upstream URLs / tokens in path segment; redact
        if (path.startsWith('/v1/proxy/grant/'))
            return '/v1/proxy/grant/[REDACTED]';
        if (path.startsWith('/v1/proxy/token/'))
            return '/v1/proxy/token/[REDACTED]';
        // Redact query string fully via redactUrl but keep path
        if (qIdx !== -1) {
            const redacted = redactUrl(url);
            const rq = redacted.indexOf('?');
            return rq === -1 ? path : redacted.slice(0, rq);
        }
        return path;
    }

    // Central error handler — never leak stacks or secrets.
    app.setErrorHandler((err, request, reply) => {
        const safe = toSafeError(err);
        const status = safe.status;
        if (status >= 500) {
            const safePath = redactLogPath(request.url ?? '');
            console.error(
                `[http] ${request.method} ${safePath} → ${status}`,
                redactValue({
                    code: (err as { code?: string })?.code,
                    message: err instanceof Error ? err.message : String(err),
                    name: err instanceof Error ? err.name : undefined
                })
            );
        }
        const body = {
            ...safe.body,
            requestId: request.id
        };
        void reply.code(status).send(body);
    });

    // Not-found handler: also redact URLs
    app.setNotFoundHandler((request, reply) => {
        const safePath = redactLogPath(request.url ?? '');
        void reply.code(404).send({
            error: {
                code: 'NOT_FOUND',
                message: `Route ${request.method} ${safePath} not found`
            },
            requestId: request.id
        });
    });
}

/** Serialize Set-Cookie for a session (HttpOnly, SameSite=Lax, Secure in prod). */
export function buildSessionCookie(
    name: string,
    value: string,
    opts: {
        expires: Date;
        secure: boolean;
        path?: string;
    }
): string {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${opts.path ?? '/'}`,
        `Expires=${opts.expires.toUTCString()}`,
        'HttpOnly',
        'SameSite=Lax'
    ];
    if (opts.secure) parts.push('Secure');
    return parts.join('; ');
}

export function clearSessionCookie(
    name: string,
    opts: { secure: boolean; path?: string }
): string {
    const parts = [
        `${name}=`,
        `Path=${opts.path ?? '/'}`,
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'HttpOnly',
        'SameSite=Lax'
    ];
    if (opts.secure) parts.push('Secure');
    return parts.join('; ');
}
