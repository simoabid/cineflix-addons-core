/**
 * Short-lived PlaybackGrant — replaces arbitrary caller-supplied proxy URLs.
 *
 * A grant binds:
 *   - upstream URL (validated at issue time)
 *   - approved upstream request headers
 *   - provider/addon id
 *   - expiry
 *   - optional media identity
 *
 * Public clients redeem `/v1/proxy/grant/:id` (opaque) or a compact
 * HMAC-signed token. The legacy `/v1/proxy?data=` path is disabled in
 * production and denied by default when SECURE_PROXY=true.
 *
 * Storage is in-process Map with TTL (phase 1). Redis-backed grants land
 * with the multi-instance persistence work.
 */

import {
    createHmac,
    randomBytes,
    timingSafeEqual,
    createCipheriv,
    createDecipheriv,
    createHash
} from 'node:crypto';
import { globalMetrics } from '../metrics/index.js';
import {
    validateOutboundUrl,
    type UrlPolicyOptions,
    UrlPolicyError
} from './urlPolicy.js';
import { redactUrl, redactHeaders } from './redaction.js';

/** Raised when the active-grant hard cap is reached (Phase 7 §10.4). */
export class GrantCapacityError extends Error {
    readonly code = 'GRANT_CAPACITY_EXCEEDED';
    constructor(maxActive: number) {
        super(
            `Playback grant capacity reached (${maxActive} active) — refusing to mint more until existing grants expire`
        );
        this.name = 'GrantCapacityError';
    }
}

export interface PlaybackGrantClaims {
    /** Opaque grant id. */
    id: string;
    /** Upstream media/manifest URL. */
    url: string;
    /** Approved upstream headers (never returned to clients). */
    headers: Record<string, string>;
    /** Provider / addon id that issued the source. */
    providerId?: string;
    /** Optional media identity for diagnostics. */
    mediaKey?: string;
    /** Unix epoch seconds. */
    exp: number;
    /** Unix epoch seconds. */
    iat: number;
    /** Max redirects the proxy may follow for this grant. */
    maxRedirects: number;
    /** Optional single-use flag. */
    singleUse?: boolean;
    /** Addon revision at grant issue time - used to invalidate grants when addon changes */
    addonRevision?: number;
}

export interface IssueGrantInput {
    url: string;
    headers?: Record<string, string>;
    providerId?: string;
    mediaKey?: string;
    /** TTL seconds (default 2h). */
    ttlSec?: number;
    maxRedirects?: number;
    singleUse?: boolean;
    addonRevision?: number;
}

export interface PlaybackGrantStore {
    issue(input: IssueGrantInput): Promise<PlaybackGrantClaims>;
    get(id: string): Promise<PlaybackGrantClaims | null>;
    /** Consume a single-use grant (returns null if already used / missing). */
    consume(id: string): Promise<PlaybackGrantClaims | null>;
    revoke(id: string): Promise<boolean>;
    /** Build a public proxy URL for this grant. */
    toProxyUrl(grant: PlaybackGrantClaims, publicBase: string): string;
    /** Verify a compact signed token form (optional, no server lookup). */
    verifySignedToken(token: string): PlaybackGrantClaims | null;
    /** Sign a compact token (self-contained; headers omitted for size/secrecy). */
    signCompact(grant: PlaybackGrantClaims): string;
    size(): number;
    purgeExpired(): number;
}

interface StoredGrant extends PlaybackGrantClaims {
    used?: boolean;
}

function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
        timingSafeEqual(ba, ba);
        return false;
    }
    return timingSafeEqual(ba, bb);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function b64urlJson(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function createPlaybackGrantStore(
    opts: {
        signingSecret: string;
        /** Default TTL seconds. */
        defaultTtlSec?: number;
        /** Max grants retained. */
        maxEntries?: number;
        /**
         * Phase 7 §10.4 — hard cap on active grants; issue() rejects with
         * GrantCapacityError once reached (after purging expired entries).
         * Defaults to maxEntries (per-instance cap).
         */
        maxActive?: number;
        /** URL policy applied at issue time. */
        urlPolicy?: UrlPolicyOptions;
    } & {
        redis?: { host: string; port: number; password?: string };
        useRedis?: boolean;
    }
): PlaybackGrantStore {
    const defaultTtlSec = opts.defaultTtlSec ?? 2 * 60 * 60;
    const maxEntries = opts.maxEntries ?? 50_000;
    const maxActive = opts.maxActive ?? maxEntries;
    const secret = opts.signingSecret;
    const urlPolicy: UrlPolicyOptions = {
        allowHttp: false,
        allowCredentials: false,
        ...opts.urlPolicy
    };

    const map = new Map<string, StoredGrant>();
    // Optional Redis backing for shared durable grants (P2-16)
    let redisClient: {
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string, opts?: { EX?: number }) => Promise<unknown>;
        del: (k: string) => Promise<number>;
        exists: (k: string) => Promise<number>;
    } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let redisReady = false;
    let redisInitAttempted = false;

    async function getRedis(): Promise<typeof redisClient> {
        if (redisClient) return redisClient;
        if (redisInitAttempted) return null;
        redisInitAttempted = true;
        const useRedis = (opts as { useRedis?: boolean }).useRedis;
        const redisCfg = (
            opts as {
                redis?: { host: string; port: number; password?: string };
            }
        ).redis;
        if (!useRedis || !redisCfg) return null;
        try {
            const moduleName = 'redis';
            const mod = (await import(moduleName)) as {
                createClient: (o: { url: string }) => unknown;
            };
            const auth = redisCfg.password
                ? `:${encodeURIComponent(redisCfg.password)}@`
                : '';
            const url = `redis://${auth}${redisCfg.host}:${redisCfg.port}`;
            const client = mod.createClient({ url }) as {
                connect: () => Promise<void>;
                on: (ev: string, cb: (e: unknown) => void) => void;
                get: (k: string) => Promise<string | null>;
                set: (
                    k: string,
                    v: string,
                    opts?: { EX?: number }
                ) => Promise<unknown>;
                del: (k: string) => Promise<number>;
                exists: (k: string) => Promise<number>;
            };
            client.on('error', (e) => console.error('[grants:redis] error', e));
            await client.connect();
            redisClient = client as unknown as typeof redisClient;
            redisReady = true;
            return redisClient;
        } catch {
            // Redis not available — fall back to memory (expected in dev/tests)
            return null;
        }
    }
    // Eager init (non-blocking)
    void getRedis();

    function purge(): number {
        const now = Math.floor(Date.now() / 1000);
        let n = 0;
        for (const [id, g] of map) {
            if (g.exp <= now || g.used) {
                map.delete(id);
                n++;
            }
        }
        // Hard cap: drop oldest by iat
        if (map.size > maxEntries) {
            const sorted = [...map.entries()].sort(
                (a, b) => a[1].iat - b[1].iat
            );
            const drop = sorted.slice(0, map.size - maxEntries);
            for (const [id] of drop) {
                map.delete(id);
                n++;
            }
        }
        return n;
    }

    async function issue(input: IssueGrantInput): Promise<PlaybackGrantClaims> {
        // Validate upstream URL before minting a grant.
        const validated = await validateOutboundUrl(input.url, urlPolicy);
        const now = Math.floor(Date.now() / 1000);
        const ttl = input.ttlSec ?? defaultTtlSec;
        const id = randomBytes(16).toString('base64url');

        // Phase 7 §10.4 — capacity guard: purge expired/used first, then
        // reject if the active set is still at the hard cap.
        purge();
        if (map.size >= maxActive) {
            globalMetrics.recordGrantRejected('capacity');
            throw new GrantCapacityError(maxActive);
        }
        globalMetrics.recordGrantIssued();

        // Only allow a safe subset of headers onto the grant.
        const headers: Record<string, string> = {};
        if (input.headers) {
            for (const [k, v] of Object.entries(input.headers)) {
                const lower = k.toLowerCase();
                if (
                    lower === 'cookie' ||
                    lower === 'authorization' ||
                    lower.startsWith('x-forwarded-') ||
                    lower === 'host' ||
                    lower === 'connection'
                ) {
                    continue;
                }
                // Allow common media headers the provider declared.
                headers[k] = v;
            }
        }

        const grant: StoredGrant = {
            id,
            url: validated.url.toString(),
            headers,
            providerId: input.providerId,
            mediaKey: input.mediaKey,
            exp: now + ttl,
            iat: now,
            maxRedirects: input.maxRedirects ?? 3,
            singleUse: input.singleUse,
            addonRevision: input.addonRevision
        };
        purge();
        map.set(id, grant);
        // Also store in Redis if available (shared durable)
        const r = await getRedis();
        if (r) {
            try {
                const key = `playback:grant:${id}`;
                const ttlSec = Math.max(
                    60,
                    grant.exp - Math.floor(Date.now() / 1000)
                );
                await r.set(key, JSON.stringify(grant), { EX: ttlSec });
            } catch {
                void 0;
            }
        }
        return { ...grant };
    }

    async function get(id: string): Promise<PlaybackGrantClaims | null> {
        // Try Redis first if available
        const r = await getRedis();
        if (r) {
            try {
                const raw = await r.get(`playback:grant:${id}`);
                if (raw) {
                    const g = JSON.parse(raw) as StoredGrant;
                    if (g.exp <= Math.floor(Date.now() / 1000) || g.used) {
                        try {
                            await r.del(`playback:grant:${id}`);
                        } catch {
                            void 0;
                        }
                        return null;
                    }
                    return g;
                }
            } catch {
                void 0;
            }
        }
        const g = map.get(id);
        if (!g) return null;
        if (g.exp <= Math.floor(Date.now() / 1000)) {
            map.delete(id);
            if (r)
                try {
                    await r.del(`playback:grant:${id}`);
                } catch {
                    void 0;
                }
            return null;
        }
        if (g.used) return null;
        return { ...g };
    }

    async function consume(id: string): Promise<PlaybackGrantClaims | null> {
        const r = await getRedis();
        if (r) {
            try {
                const raw = await r.get(`playback:grant:${id}`);
                if (raw) {
                    const g = JSON.parse(raw) as StoredGrant;
                    if (g.exp <= Math.floor(Date.now() / 1000) || g.used) {
                        try {
                            await r.del(`playback:grant:${id}`);
                        } catch {
                            void 0;
                        }
                        return null;
                    }
                    if (g.singleUse) {
                        try {
                            await r.del(`playback:grant:${id}`);
                        } catch {
                            void 0;
                        }
                    }
                    // Also keep map in sync
                    if (g.singleUse) map.delete(id);
                    return g;
                }
            } catch {
                void 0;
            }
        }
        const g = map.get(id);
        if (!g) return null;
        if (g.exp <= Math.floor(Date.now() / 1000)) {
            map.delete(id);
            if (r)
                try {
                    await r.del(`playback:grant:${id}`);
                } catch {
                    void 0;
                }
            return null;
        }
        if (g.used) return null;
        if (g.singleUse) {
            g.used = true;
            if (r)
                try {
                    await r.del(`playback:grant:${id}`);
                } catch {
                    void 0;
                }
        }
        return { ...g };
    }

    async function revoke(id: string): Promise<boolean> {
        const r = await getRedis();
        let redisDeleted = false;
        if (r) {
            try {
                const n = await r.del(`playback:grant:${id}`);
                redisDeleted = n > 0;
            } catch {
                void 0;
            }
        }
        const mem = map.delete(id);
        return mem || redisDeleted;
    }

    function toProxyUrl(
        grant: PlaybackGrantClaims,
        publicBase: string
    ): string {
        const base = publicBase.replace(/\/$/, '');
        return `${base}/v1/proxy/grant/${encodeURIComponent(grant.id)}`;
    }

    // Derive 32-byte key from signing secret for AES-GCM
    function deriveKey(): Buffer {
        return createHash('sha256').update(secret, 'utf8').digest();
    }

    function encryptCompact(plaintext: string): string {
        const key = deriveKey();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        return `enc1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
    }

    function decryptCompact(encStr: string): string | null {
        try {
            if (!encStr.startsWith('enc1:')) return null;
            const parts = encStr.slice(5).split(':');
            if (parts.length !== 3) return null;
            const [ivB64, tagB64, dataB64] = parts;
            const key = deriveKey();
            const iv = Buffer.from(ivB64, 'base64url');
            const tag = Buffer.from(tagB64, 'base64url');
            const data = Buffer.from(dataB64, 'base64url');
            const decipher = createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            const dec = Buffer.concat([
                decipher.update(data),
                decipher.final()
            ]);
            return dec.toString('utf8');
        } catch {
            return null;
        }
    }

    function signCompact(grant: PlaybackGrantClaims): string {
        // Compact form now encrypts sensitive claims (URL etc.) before signing
        const body = {
            id: grant.id,
            url: grant.url,
            providerId: grant.providerId,
            exp: grant.exp,
            iat: grant.iat,
            maxRedirects: grant.maxRedirects
        };
        const json = JSON.stringify(body);
        const encrypted = encryptCompact(json);
        const payload = Buffer.from(encrypted, 'utf8').toString('base64url');
        const sig = createHmac('sha256', secret)
            .update(payload)
            .digest('base64url');
        return `${payload}.${sig}`;
    }

    function verifySignedToken(token: string): PlaybackGrantClaims | null {
        const parts = token.split('.');
        if (parts.length !== 2) return null;
        const [payload, sig] = parts;
        const expected = createHmac('sha256', secret)
            .update(payload)
            .digest('base64url');
        if (!safeEqual(sig, expected)) return null;
        try {
            const outer = Buffer.from(payload, 'base64url').toString('utf8');
            // Try decrypting (new encrypted format); fall back to plain JSON for backwards compat / tests
            let jsonStr: string | null = null;
            if (outer.startsWith('enc1:')) {
                jsonStr = decryptCompact(outer);
                if (!jsonStr) return null;
            } else {
                // Legacy plaintext fallback (only allowed in non-production or for migration)
                // In production, reject plaintext compact tokens
                const isProd = process.env.NODE_ENV === 'production';
                if (isProd) return null;
                jsonStr = Buffer.from(payload, 'base64url').toString('utf8');
            }
            const body = JSON.parse(jsonStr) as {
                id: string;
                url: string;
                providerId?: string;
                exp: number;
                iat: number;
                maxRedirects?: number;
            };
            if (!body.id || !body.url || !body.exp) return null;
            if (body.exp < Math.floor(Date.now() / 1000)) return null;
            // Prefer live store copy (has headers); fall back to compact claims.
            const live = map.get(body.id);
            if (
                live &&
                live.exp >= Math.floor(Date.now() / 1000) &&
                !live.used
            ) {
                return { ...live };
            }
            return {
                id: body.id,
                url: body.url,
                headers: {},
                providerId: body.providerId,
                exp: body.exp,
                iat: body.iat,
                maxRedirects: body.maxRedirects ?? 3
            };
        } catch {
            return null;
        }
    }

    return {
        issue,
        get,
        consume,
        revoke,
        toProxyUrl,
        signCompact,
        verifySignedToken,
        size: () => map.size,
        purgeExpired: purge
    };
}

/** Safe diagnostic view of a grant (no headers, redacted URL). */
export function grantPublicView(
    grant: PlaybackGrantClaims
): Record<string, unknown> {
    return {
        id: grant.id,
        url: redactUrl(grant.url),
        providerId: grant.providerId,
        mediaKey: grant.mediaKey,
        exp: grant.exp,
        iat: grant.iat,
        maxRedirects: grant.maxRedirects,
        singleUse: Boolean(grant.singleUse),
        headers: redactHeaders(grant.headers)
    };
}

export { UrlPolicyError };
