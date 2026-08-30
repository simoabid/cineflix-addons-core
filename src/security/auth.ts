/**
 * Administration authentication and authorization.
 *
 * AUTH_MODE:
 *   - disabled       Local development only (requires ALLOW_INSECURE_ADMIN=true
 *                    outside of non-production, and is refused in production).
 *   - static-token   Single shared operator token (x-admin-token / Authorization).
 *   - reverse-proxy  Trust identity headers from a trusted reverse proxy/SSO.
 *   - service-jwt    HMAC-signed short-lived service JWTs (HS256).
 *   - oidc           Reserved; not fully implemented in phase 1 (fails closed).
 *
 * Roles (minimum set from the plan):
 *   viewer   — read non-sensitive health/provider data
 *   operator — health/refresh + enable/order/timeout
 *   admin    — import/remove + debrid/settings
 *
 * Tokens are accepted via headers only — never query strings.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig, AuthMode } from '../config.js';

export type Role = 'viewer' | 'operator' | 'admin';
export type AuthMethod =
    'none' | 'static-token' | 'reverse-proxy' | 'service-jwt' | 'session';

export interface AuthActor {
    id: string;
    role: Role;
    method: AuthMethod;
    ip?: string;
}

export interface AuthContext {
    actor: AuthActor;
}

declare module 'fastify' {
    interface FastifyRequest {
        auth?: AuthContext;
    }
}

function ipToInt(ip: string): number | null {
    const parts = ip.split('.').map(Number);
    if (
        parts.length !== 4 ||
        parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
        return null;
    return (
        ((parts[0] << 24) >>> 0) +
        ((parts[1] << 16) >>> 0) +
        ((parts[2] << 8) >>> 0) +
        (parts[3] >>> 0)
    );
}

function isIpInCidr(ip: string, cidr: string): boolean {
    const slash = cidr.indexOf('/');
    if (slash === -1) {
        return ip.toLowerCase() === cidr.toLowerCase();
    }
    const base = cidr.slice(0, slash).trim();
    const bits = Number(cidr.slice(slash + 1).trim());
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
    const ipNum = ipToInt(ip);
    const baseNum = ipToInt(base);
    if (ipNum === null || baseNum === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
    return (ipNum & mask) === (baseNum & mask);
}

function normalizePeerIp(raw: string | undefined): string | null {
    if (!raw) return null;
    let s = raw.trim();
    // Node may give ::ffff:127.0.0.1 mapped addresses
    if (s.startsWith('::ffff:')) s = s.slice('::ffff:'.length);
    // Strip brackets and port
    if (s.startsWith('[')) {
        const close = s.indexOf(']');
        if (close !== -1) s = s.slice(1, close);
    } else if (s.includes(':') && !s.includes('.')) {
        // IPv6 without brackets — treat as not matched for IPv4 CIDRs
        return null;
    }
    // Remove port if present (IPv4 with :port)
    const colon = s.lastIndexOf(':');
    if (
        colon !== -1 &&
        s.indexOf(':') === colon &&
        /^\d+$/.test(s.slice(colon + 1))
    ) {
        s = s.slice(0, colon);
    }
    if (isIP(s) === 0) return null;
    // For IPv6 localhost, treat ::1 as 127.0.0.1 for convenience
    if (s === '::1') return '127.0.0.1';
    return s;
}

export function isTrustedPeer(
    peerIp: string | undefined,
    cidrs: string[]
): boolean {
    if (!cidrs || cidrs.length === 0) return false;
    const normalized = normalizePeerIp(peerIp);
    if (!normalized) return false;
    // Allow explicit localhost when CIDR includes it
    for (const cidr of cidrs) {
        const c = cidr.trim();
        if (!c) continue;
        if (c === '127.0.0.1' || c === 'localhost') {
            if (normalized === '127.0.0.1') return true;
            continue;
        }
        if (isIpInCidr(normalized, c)) return true;
        // Exact match fallback
        if (normalized.toLowerCase() === c.toLowerCase()) return true;
    }
    return false;
}

const ROLE_RANK: Record<Role, number> = {
    viewer: 1,
    operator: 2,
    admin: 3
};

export function roleAtLeast(have: Role, need: Role): boolean {
    return ROLE_RANK[have] >= ROLE_RANK[need];
}

export function parseRole(
    raw: string | undefined,
    fallback: Role = 'admin'
): Role {
    const v = (raw ?? '').trim().toLowerCase();
    if (v === 'viewer' || v === 'operator' || v === 'admin') return v;
    return fallback;
}

function clientIp(request: FastifyRequest): string | undefined {
    const sockIp =
        (request.socket?.remoteAddress as string | undefined)?.replace(
            /^::ffff:/,
            ''
        ) ?? request.ip;
    return sockIp;
}

export function getRateLimitIp(
    request: FastifyRequest,
    cfg?: { trustedProxyCidrs?: string[] }
): string | undefined {
    const sockIp =
        (request.socket?.remoteAddress as string | undefined)?.replace(
            /^::ffff:/,
            ''
        ) ?? request.ip;
    if (!cfg?.trustedProxyCidrs || cfg.trustedProxyCidrs.length === 0) {
        return sockIp;
    }
    const peer =
        (request.socket?.remoteAddress as string | undefined) ?? request.ip;
    if (isTrustedPeer(peer, cfg.trustedProxyCidrs)) {
        const xf = request.headers['x-forwarded-for'];
        if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
        if (Array.isArray(xf) && xf[0]) return xf[0].split(',')[0].trim();
    }
    return sockIp;
}

function headerValue(
    request: FastifyRequest,
    name: string
): string | undefined {
    const v = request.headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    return typeof v === 'string' ? v : undefined;
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
        // Compare against self to keep timing similar, then fail.
        timingSafeEqual(ba, ba);
        return false;
    }
    return timingSafeEqual(ba, bb);
}

function extractBearer(request: FastifyRequest): string | undefined {
    const auth = headerValue(request, 'authorization');
    if (!auth) return undefined;
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m?.[1]?.trim();
}

function extractStaticToken(request: FastifyRequest): string | undefined {
    return (
        headerValue(request, 'x-admin-token') ||
        extractBearer(request) ||
        undefined
    );
}

// ── service-jwt (compact HS256) ──────────────────────────────────────────────

interface ServiceJwtClaims {
    sub: string;
    role: Role;
    iat: number;
    exp: number;
}

function b64url(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64url');
}

function b64urlJson(obj: unknown): string {
    return b64url(JSON.stringify(obj));
}

export function signServiceJwt(
    claims: Omit<ServiceJwtClaims, 'iat' | 'exp'> & { ttlSec?: number },
    secret: string
): string {
    const now = Math.floor(Date.now() / 1000);
    const full: ServiceJwtClaims = {
        sub: claims.sub,
        role: claims.role,
        iat: now,
        exp: now + (claims.ttlSec ?? 3600)
    };
    const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = b64urlJson(full);
    const sig = createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url');
    return `${header}.${payload}.${sig}`;
}

export function verifyServiceJwt(
    token: string,
    secret: string
): ServiceJwtClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
        const claims = JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf8')
        ) as ServiceJwtClaims;
        if (!claims.sub || !claims.role || !claims.exp) return null;
        if (claims.exp < Math.floor(Date.now() / 1000)) return null;
        if (!['viewer', 'operator', 'admin'].includes(claims.role)) return null;
        return claims;
    } catch {
        return null;
    }
}

// ── session tokens for admin UI (HttpOnly cookie alternative to localStorage)
// Compact HMAC token: base64url(payload).base64url(sig)
// payload = { sub, role, exp, iat }

export interface SessionClaims {
    sub: string;
    role: Role;
    iat: number;
    exp: number;
}

export function signSession(
    claims: { sub: string; role: Role; ttlSec?: number },
    secret: string
): { token: string; expiresAt: Date } {
    const now = Math.floor(Date.now() / 1000);
    const ttl = claims.ttlSec ?? 60 * 60 * 8; // 8h default
    const full: SessionClaims = {
        sub: claims.sub,
        role: claims.role,
        iat: now,
        exp: now + ttl
    };
    const payload = b64urlJson(full);
    const sig = createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
    return {
        token: `${payload}.${sig}`,
        expiresAt: new Date((now + ttl) * 1000)
    };
}

export function verifySession(
    token: string,
    secret: string
): SessionClaims | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
        const claims = JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf8')
        ) as SessionClaims;
        if (!claims.sub || !claims.role || !claims.exp) return null;
        if (claims.exp < Math.floor(Date.now() / 1000)) return null;
        return claims;
    } catch {
        return null;
    }
}

export const SESSION_COOKIE = 'addons_core_session';

// ── resolve actor ────────────────────────────────────────────────────────────

export function resolveActor(
    request: FastifyRequest,
    cfg: AppConfig
): AuthActor | null {
    const ip = clientIp(request);
    const mode: AuthMode = cfg.authMode;

    if (mode === 'disabled') {
        return {
            id: 'local-dev',
            role: 'admin',
            method: 'none',
            ip
        };
    }

    // Session cookie (works across modes that have a signing secret).
    // Cookies are attached by registerHttpSecurity's onRequest hook.
    const sessionSecret =
        cfg.authSessionSecret || cfg.adminToken || cfg.serviceJwtSecret;
    if (sessionSecret) {
        const cookies = (
            request as FastifyRequest & {
                cookies?: Record<string, string>;
            }
        ).cookies;
        const rawCookie = cookies?.[SESSION_COOKIE];
        if (rawCookie) {
            const claims = verifySession(rawCookie, sessionSecret);
            if (claims) {
                return {
                    id: claims.sub,
                    role: claims.role,
                    method: 'session',
                    ip
                };
            }
        }
    }

    if (mode === 'static-token') {
        const provided = extractStaticToken(request);
        if (!provided || !cfg.adminToken) return null;
        if (!safeEqual(provided, cfg.adminToken)) return null;
        return {
            id: 'admin-token',
            role: cfg.adminTokenRole,
            method: 'static-token',
            ip
        };
    }

    if (mode === 'reverse-proxy') {
        // Trust peer check: only accept identity headers when the immediate
        // network peer is in TRUSTED_PROXY_CIDRS. This prevents direct callers
        // from forging x-forwarded-user / x-forwarded-role.
        const peerIp =
            (request.socket?.remoteAddress as string | undefined) ||
            (request as { ip?: string }).ip ||
            ip;
        if (!isTrustedPeer(peerIp, cfg.trustedProxyCidrs)) {
            // Also log for operator visibility; do not reveal peer details to caller.
            return null;
        }
        const userHeader = cfg.proxyUserHeader || 'x-forwarded-user';
        const roleHeader = cfg.proxyRoleHeader || 'x-forwarded-role';
        const user = headerValue(request, userHeader);
        if (!user) return null;
        const role = parseRole(headerValue(request, roleHeader), 'viewer');
        return {
            id: user,
            role,
            method: 'reverse-proxy',
            ip
        };
    }

    if (mode === 'service-jwt') {
        const token =
            extractBearer(request) || headerValue(request, 'x-admin-token');
        if (!token || !cfg.serviceJwtSecret) return null;
        const claims = verifyServiceJwt(token, cfg.serviceJwtSecret);
        if (!claims) return null;
        return {
            id: claims.sub,
            role: claims.role,
            method: 'service-jwt',
            ip
        };
    }

    if (mode === 'oidc') {
        // Phase 1: reserved. Fail closed — no actor.
        return null;
    }

    return null;
}

export interface GuardOptions {
    /** Minimum role required. Default admin for destructive safety. */
    role?: Role;
    /** When true, unauthenticated requests get 401 (default). */
    required?: boolean;
}

/**
 * Build a Fastify preHandler that enforces auth + role.
 * Attaches `request.auth` on success.
 */
export function makeAuthGuard(cfg: AppConfig, options: GuardOptions = {}) {
    const need = options.role ?? 'admin';
    const required = options.required !== false;

    return async function authGuard(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        // Hard reject query-string tokens — they leak via logs/referrers.
        const q = request.query as Record<string, unknown> | undefined;
        if (
            q &&
            (q.token != null || q.adminToken != null || q.access_token != null)
        ) {
            await reply.code(400).send({
                error: {
                    code: 'TOKEN_IN_QUERY_FORBIDDEN',
                    message:
                        'Credentials must be sent via headers (x-admin-token or Authorization), never query strings'
                }
            });
            return;
        }

        const actor = resolveActor(request, cfg);
        if (!actor) {
            if (!required) return;
            await reply.code(401).send({
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Authentication required'
                }
            });
            return;
        }

        if (!roleAtLeast(actor.role, need)) {
            await reply.code(403).send({
                error: {
                    code: 'FORBIDDEN',
                    message: `Role '${need}' required (have '${actor.role}')`
                }
            });
            return;
        }

        request.auth = { actor };
    };
}

/** @deprecated Use makeAuthGuard. Kept as a thin alias during migration. */
export function makeAdminGuard(cfg: AppConfig) {
    return makeAuthGuard(cfg, { role: 'admin' });
}

/** Generate a high-entropy admin token for bootstrap docs. */
export function generateAdminToken(): string {
    return randomBytes(32).toString('base64url');
}
