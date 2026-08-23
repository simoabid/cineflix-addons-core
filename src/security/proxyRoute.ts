/**
 * Secure playback proxy routes.
 *
 *   GET /v1/proxy/grant/:grantId   — redeem an opaque server-side grant
 *   GET /v1/proxy/token/*          — redeem a compact HMAC-signed token
 *
 * Legacy `/v1/proxy?data=` (framework) is blocked by a preHandler when
 * secure proxy mode is mandatory, and always blocked in production.
 *
 * Supports Range requests. Follows redirects only to revalidated targets.
 * Does not forward client cookies or Authorization.
 */

import { Readable, Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import {
    createPlaybackGrantStore,
    type PlaybackGrantClaims,
    type PlaybackGrantStore
} from './playbackGrant.js';
import { validateOutboundUrl, UrlPolicyError } from './urlPolicy.js';
import { createRateLimiter, RATE_LIMITS, rateLimitKey } from './rateLimit.js';
import { scrapeFetch, shouldProxyUrl } from '../egress/scrapeFetch.js';
import { getRateLimitIp } from './auth.js';
import { globalMetrics } from '../metrics/index.js';
import { globalConcurrency } from '../concurrency/coordinator.js';
import {
    StreamConcurrencyError,
    StreamConcurrencyTracker,
    EgressBudgetMonitor
} from '../capacity/index.js';
import { logger } from '../telemetry/logger.js';

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'cookie',
    'authorization'
]);

export interface SecureProxyContext {
    grants: PlaybackGrantStore;
    /** Phase 7 §10.4 — concurrent stream caps (per IP / user / global). */
    streams?: StreamConcurrencyTracker;
    /** Phase 7 §10.4 — egress byte budget accounting. */
    egress?: EgressBudgetMonitor;
    /** Phase 7 §10.4 — max child grants a single manifest rewrite may mint. */
    maxGrantsPerRequest?: number;
}

export function createSecureProxyContext(cfg: AppConfig): SecureProxyContext {
    // In production, PLAYBACK_GRANT_SECRET must be explicit; do not fall back to dev secret.
    // In development, allow fallback chain for convenience but never use default in prod.
    let secret = cfg.playbackGrantSecret;
    const isProd = cfg.nodeEnv === 'production';
    const DEV_FALLBACK = 'addons-core-dev-grant-secret';
    if (!secret) {
        if (isProd) {
            throw new Error(
                'PLAYBACK_GRANT_SECRET is required in production — refusing to start with dev fallback'
            );
        }
        secret =
            cfg.authSessionSecret ||
            cfg.adminToken ||
            cfg.serviceJwtSecret ||
            DEV_FALLBACK;
    }
    if (isProd && secret === DEV_FALLBACK) {
        throw new Error(
            'PLAYBACK_GRANT_SECRET must not be the dev fallback in production'
        );
    }
    if (isProd && secret.length < 32) {
        throw new Error(
            'PLAYBACK_GRANT_SECRET must be at least 32 characters in production'
        );
    }
    // Enforce Redis-backed grants in production so revocation and grants are shared
    // across instances and survive restarts; process-local memory would split state.
    if (isProd && cfg.cacheType !== 'redis' && cfg.store !== 'redis') {
        throw new Error(
            'CACHE_TYPE=redis or ADDONS_STORE=redis is required in production for playback grants to be shared across instances/restarts — refusing to start with process-local memory grants'
        );
    }

    const grants = createPlaybackGrantStore({
        signingSecret: secret,
        defaultTtlSec: cfg.playbackGrantTtlSec,
        // Phase 7 §10.4 — hard cap on concurrent active grants.
        maxActive: cfg.playbackGrantMaxActive,
        urlPolicy: {
            allowHttp: cfg.allowHttpUpstreams,
            hostAllowlist:
                cfg.outboundHostAllowlist.length > 0
                    ? cfg.outboundHostAllowlist
                    : undefined,
            allowHostSuffixes: [
                ...cfg.outboundHostAllowSuffixes,
                'real-debrid.com',
                'alldebrid.com',
                'premiumize.me',
                'debrid.it'
            ]
        },
        // Use Redis when configured for durable shared grants; in production we
        // have already enforced above that at least one of cacheType/store is redis,
        // and loadConfig defaults CACHE_TYPE to redis in production.
        ...(cfg.cacheType === 'redis' || cfg.store === 'redis'
            ? { useRedis: true, redis: cfg.redis }
            : {})
    });
    return { grants };
}

/**
 * Build the Phase 7 §10.4 capacity guards for the proxy context
 * (stream concurrency caps + egress budget). Called from server.ts so the
 * same instances feed /health/status and /metrics.
 */
export function createProxyCapacityGuards(cfg: AppConfig): {
    streams: StreamConcurrencyTracker;
    egress: EgressBudgetMonitor;
    maxGrantsPerRequest: number;
} {
    const useRedis = cfg.cacheType === 'redis' || cfg.store === 'redis';
    return {
        streams: new StreamConcurrencyTracker({
            maxPerIp: cfg.maxConcurrentStreamsPerIp,
            maxPerUser: cfg.maxConcurrentStreamsPerUser,
            maxGlobal: cfg.maxConcurrentStreamsGlobal,
            redis: useRedis ? cfg.redis : undefined
        }),
        egress: new EgressBudgetMonitor({
            dailyBudgetBytes: cfg.egressDailyBudgetMb * 1024 * 1024,
            proxyBudgetBytes: cfg.egressProxyDailyBudgetMb * 1024 * 1024
        }),
        maxGrantsPerRequest: cfg.playbackGrantMaxPerRequest
    };
}

function clientIp(
    request: FastifyRequest,
    cfg?: AppConfig
): string | undefined {
    if (cfg) return getRateLimitIp(request, cfg);
    return getRateLimitIp(request);
}

function buildUpstreamHeaders(
    grant: PlaybackGrantClaims,
    request: FastifyRequest
): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };
    for (const [k, v] of Object.entries(grant.headers ?? {})) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = v;
    }
    const range = request.headers.range || request.headers.Range;
    if (typeof range === 'string' && range) {
        headers['Range'] = range;
    }
    return headers;
}

function isManifestUrl(url: string, contentType: string): boolean {
    const u = url.toLowerCase();
    const ct = contentType.toLowerCase();
    return (
        u.includes('.m3u8') ||
        u.includes('.mpd') ||
        ct.includes('mpegurl') ||
        ct.includes('dash+xml') ||
        ct.includes('application/vnd.apple.mpegurl')
    );
}

function shouldStream(url: string, contentType: string): boolean {
    const u = url.toLowerCase();
    const ct = contentType.toLowerCase();
    if (isManifestUrl(url, contentType)) return false;
    if (/\.(mp4|mkv|webm|avi|mov|ts|m4s)(\?|$)/i.test(u)) return true;
    if (ct.startsWith('video/') || ct.startsWith('audio/')) return true;
    if (ct.includes('octet-stream')) return true;
    return false;
}

function mimeFromUrl(url: string): string {
    const u = url.toLowerCase();
    if (u.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (u.includes('.mpd')) return 'application/dash+xml';
    if (u.includes('.mp4')) return 'video/mp4';
    if (u.includes('.mkv')) return 'video/x-matroska';
    if (u.includes('.webm')) return 'video/webm';
    if (u.includes('.ts')) return 'video/mp2t';
    if (u.includes('.vtt')) return 'text/vtt';
    if (u.includes('.srt')) return 'text/plain';
    return 'application/octet-stream';
}

function isDashManifest(
    body: string,
    contentType: string,
    url: string
): boolean {
    const ct = contentType.toLowerCase();
    if (ct.includes('dash+xml')) return true;
    if (url.toLowerCase().includes('.mpd')) return true;
    // Detect XML MPD structure even if content-type generic
    const trimmed = body.trimStart().slice(0, 1024).toLowerCase();
    if (trimmed.startsWith('<?xml') && body.includes('<MPD')) return true;
    if (body.includes('<MPD') && body.includes('<Period')) return true;
    return false;
}

/** Per-request child-grant budget (Phase 7 §10.4): stops manifest rewrites
 * from minting unbounded segment grants; remaining URLs keep their upstream
 * form once the budget is spent. */
interface GrantBudget {
    remaining: number;
}

async function rewriteDashManifest(
    body: string,
    manifestUrl: string,
    grant: PlaybackGrantClaims,
    ctx: SecureProxyContext,
    publicBase: string,
    budget: GrantBudget
): Promise<string> {
    const base = new URL(manifestUrl);
    const ttlSec = Math.max(60, grant.exp - Math.floor(Date.now() / 1000));

    // Helper to attempt grant and return proxied URL or null if blocked
    // For DASH templates containing $ vars (e.g. seg-$Number$.m4s), preserve the variable
    // by issuing a grant for the base directory and appending the template suffix.
    async function grantFor(raw: string): Promise<string | null> {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (budget.remaining <= 0) return null;
        if (/^\$[^$]+\$$/.test(trimmed)) return null;
        // Detect DASH template variables
        const isTemplate = trimmed.includes('$');
        try {
            if (isTemplate) {
                // For templated URLs, issue grant for the directory base and preserve template
                // e.g. "seg-$Number$.m4s" -> grant for "https://cdn.example/video/" + template suffix
                const absTemplate = new URL(trimmed, base).toString();
                // Extract directory part of the absolute template (up to last / before $)
                const dollarIdx = absTemplate.indexOf('$');
                const slashIdx = absTemplate.lastIndexOf('/', dollarIdx);
                const baseDir =
                    slashIdx !== -1
                        ? absTemplate.slice(0, slashIdx + 1)
                        : new URL('.', absTemplate).toString();
                if (!/^https?:\/\//i.test(baseDir)) return null;
                // Validate and issue grant for the base directory
                const child = await ctx.grants.issue({
                    url: baseDir,
                    headers: grant.headers,
                    providerId: grant.providerId,
                    mediaKey: grant.mediaKey,
                    ttlSec,
                    maxRedirects: grant.maxRedirects
                });
                budget.remaining--;
                const proxyBase = ctx.grants.toProxyUrl(child, publicBase);
                // Preserve the template suffix including variables
                // Compute the suffix relative to baseDir
                const suffix = absTemplate.slice(baseDir.length);
                // If suffix is empty (template was just base), return proxy base
                if (!suffix) return proxyBase;
                // Ensure suffix still contains $ variables; append to proxy URL
                // Proxy handler supports /grant/:id/* suffix for DASH
                return `${proxyBase}/${suffix.replace(/^\/+/, '')}`;
            }
            // Non-templated: normal grant for exact URL
            const abs = new URL(trimmed, base).toString();
            if (!/^https?:\/\//i.test(abs)) return null;
            const child = await ctx.grants.issue({
                url: abs,
                headers: grant.headers,
                providerId: grant.providerId,
                mediaKey: grant.mediaKey,
                ttlSec,
                maxRedirects: grant.maxRedirects
            });
            budget.remaining--;
            return ctx.grants.toProxyUrl(child, publicBase);
        } catch {
            return null;
        }
    }

    let out = body;

    // 1. Rewrite <BaseURL>text</BaseURL>
    out = await replaceAsync(
        out,
        /<BaseURL([^>]*)>([^<]+)<\/BaseURL>/gi,
        async (_m, attrs, content) => {
            const proxied = await grantFor(content);
            if (proxied) return `<BaseURL${attrs}>${proxied}</BaseURL>`;
            return _m;
        }
    );

    // 2. Rewrite Location element
    out = await replaceAsync(
        out,
        /<Location>([^<]+)<\/Location>/gi,
        async (_m, content) => {
            const proxied = await grantFor(content);
            if (proxied) return `<Location>${proxied}</Location>`;
            return _m;
        }
    );

    // 3. Rewrite attributes that commonly hold URLs: sourceURL, media, initialization, mediaRange etc.
    // We handle quoted attributes containing a URL-like value.
    const attrNames = [
        'sourceURL',
        'media',
        'initialization',
        'mediaRange',
        'indexRange',
        'href'
    ];
    for (const attr of attrNames) {
        const re = new RegExp(`(${attr}\\s*=\\s*")([^"]+)(")`, 'gi');
        out = await replaceAsync(out, re, async (_m, pre, val, post) => {
            // Skip DASH number templates that are not absolute URLs but should be proxied as paths
            // Only rewrite if val looks like a URL or path (contains / or . or :)
            if (!/[/.:]/.test(val)) return _m;
            const proxied = await grantFor(val);
            if (proxied) return `${pre}${proxied}${post}`;
            return _m;
        });
    }

    // 4. Escape hatch: rewrite any remaining absolute https URLs in text (e.g. inside AdaptationSet)
    // Limit to URLs that are not already proxied and are http(s)
    // We avoid rewriting URLs inside already-proxied grant URLs by checking for /v1/proxy/
    out = await replaceAsync(out, /https?:\/\/[^\s"'<>]+/gi, async (match) => {
        if (match.includes('/v1/proxy/')) return match;
        const proxied = await grantFor(match);
        return proxied ?? match;
    });

    return out;
}

/** Helper for async string replace. */
async function replaceAsync(
    input: string,
    regex: RegExp,
    asyncFn: (...args: string[]) => Promise<string>
): Promise<string> {
    const matches: Array<{ match: string; index: number; groups: string[] }> =
        [];
    let m: RegExpExecArray | null;
    const re = new RegExp(regex.source, regex.flags);
    while ((m = re.exec(input)) !== null) {
        matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
        if (m[0].length === 0) re.lastIndex++;
    }
    if (matches.length === 0) return input;
    let result = '';
    let last = 0;
    for (const { match, index, groups } of matches) {
        result += input.slice(last, index);
        const replacement = await asyncFn(match, ...groups);
        result += replacement;
        last = index + match.length;
    }
    result += input.slice(last);
    return result;
}

async function rewriteManifest(
    body: string,
    manifestUrl: string,
    grant: PlaybackGrantClaims,
    ctx: SecureProxyContext,
    publicBase: string,
    contentType = '',
    budget: GrantBudget
): Promise<string> {
    // Route to DASH-aware rewriter when needed; HLS remains line-based.
    if (isDashManifest(body, contentType, manifestUrl)) {
        return rewriteDashManifest(
            body,
            manifestUrl,
            grant,
            ctx,
            publicBase,
            budget
        );
    }
    const base = new URL(manifestUrl);
    const lines = body.split(/\r?\n/);
    const out: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            if (trimmed.startsWith('#') && /URI="/i.test(trimmed)) {
                out.push(
                    await replaceUriAttrs(
                        trimmed,
                        base,
                        grant,
                        ctx,
                        publicBase,
                        budget
                    )
                );
            } else {
                out.push(line);
            }
            continue;
        }
        try {
            if (budget.remaining <= 0) {
                out.push(line);
                continue;
            }
            const abs = new URL(trimmed, base).toString();
            const child = await ctx.grants.issue({
                url: abs,
                headers: grant.headers,
                providerId: grant.providerId,
                mediaKey: grant.mediaKey,
                ttlSec: Math.max(60, grant.exp - Math.floor(Date.now() / 1000)),
                maxRedirects: grant.maxRedirects
            });
            budget.remaining--;
            out.push(ctx.grants.toProxyUrl(child, publicBase));
        } catch {
            out.push('# addons-core: segment blocked by url policy');
        }
    }
    return out.join('\n');
}

async function replaceUriAttrs(
    line: string,
    base: URL,
    grant: PlaybackGrantClaims,
    ctx: SecureProxyContext,
    publicBase: string,
    budget: GrantBudget
): Promise<string> {
    const re = /URI="([^"]+)"/gi;
    let result = line;
    const matches = [...line.matchAll(re)];
    for (const m of matches) {
        const raw = m[1];
        try {
            if (budget.remaining <= 0) continue;
            const abs = new URL(raw, base).toString();
            const child = await ctx.grants.issue({
                url: abs,
                headers: grant.headers,
                providerId: grant.providerId,
                mediaKey: grant.mediaKey,
                ttlSec: Math.max(60, grant.exp - Math.floor(Date.now() / 1000)),
                maxRedirects: grant.maxRedirects
            });
            budget.remaining--;
            const proxied = ctx.grants.toProxyUrl(child, publicBase);
            result = result.replace(`URI="${raw}"`, `URI="${proxied}"`);
        } catch {
            /* leave original rather than open an SSRF hole */
        }
    }
    return result;
}

/** Record proxied bytes against the egress budget (Phase 7 §10.4). */
function recordEgress(
    ctx: SecureProxyContext,
    url: string,
    bytes: number
): void {
    if (!ctx.egress || bytes <= 0) return;
    try {
        ctx.egress.record(bytes, shouldProxyUrl(url, 'auto'));
    } catch {
        /* accounting must never break playback */
    }
}

async function fetchGrantUpstream(
    grant: PlaybackGrantClaims,
    request: FastifyRequest,
    cfg: AppConfig
): Promise<Response & { finalUrl?: string }> {
    const policy = {
        allowHttp: cfg.allowHttpUpstreams,
        hostAllowlist:
            cfg.outboundHostAllowlist.length > 0
                ? cfg.outboundHostAllowlist
                : undefined,
        allowHostSuffixes: cfg.outboundHostAllowSuffixes
    };

    let current = grant.url;
    let redirects = 0;
    const maxRedirects = grant.maxRedirects ?? 3;
    const headers = buildUpstreamHeaders(grant, request);
    const deadline = Date.now() + cfg.proxyTimeoutMs;

    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw Object.assign(new Error('Upstream proxy timeout'), {
                statusCode: 504,
                code: 'PROXY_TIMEOUT'
            });
        }
        const validated = await validateOutboundUrl(current, policy);

        const res = (await scrapeFetch(validated.url.toString(), {
            method: 'GET',
            headers,
            redirect: 'manual',
            timeoutMs: remaining,
            viaProxy: 'auto',
            ...(validated.pinnedAddress &&
            validated.pinnedAddress !== validated.hostname
                ? { pinnedIp: validated.pinnedAddress }
                : {})
        })) as Response & { finalUrl?: string };

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) {
                throw Object.assign(new Error('Redirect without Location'), {
                    statusCode: 502,
                    code: 'BAD_REDIRECT'
                });
            }
            redirects += 1;
            if (redirects > maxRedirects) {
                throw Object.assign(new Error('Too many upstream redirects'), {
                    statusCode: 502,
                    code: 'TOO_MANY_REDIRECTS'
                });
            }
            current = new URL(location, current).toString();
            continue;
        }
        res.finalUrl = current;
        return res;
    }
}

async function handleGrantRequest(
    grant: PlaybackGrantClaims,
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: SecureProxyContext,
    cfg: AppConfig,
    publicBase: string,
    opts: { segment?: boolean } = {}
): Promise<void> {
    if (request.headers.range) {
        globalMetrics.recordProxyRangeRequest();
    }
    // Phase 7 §10.1 — full media streams and HLS/DASH segments draw from
    // separate pools so segment bursts can't crowd out new playbacks.
    const pool = opts.segment ? 'hls-segment' : 'proxy-stream';
    let upstream: Response & { finalUrl?: string };
    try {
        upstream = await globalConcurrency.withSlot(pool, () =>
            fetchGrantUpstream(grant, request, cfg)
        );
    } catch (err) {
        if (err instanceof UrlPolicyError) {
            globalMetrics.recordProxyDeniedSsrf();
            await reply.code(403).send({
                error: {
                    code: 'URL_POLICY_VIOLATION',
                    message: 'Upstream URL is not permitted'
                }
            });
            return;
        }
        const poolCode = (err as { code?: string }).code;
        if (poolCode === 'SEMAPHORE_FULL' || poolCode === 'QUEUE_TIMEOUT') {
            reply.header('Retry-After', '2');
            await reply.code(503).send({
                error: {
                    code: 'OVERLOADED',
                    message:
                        err instanceof Error
                            ? err.message
                            : 'Concurrency pool saturated'
                }
            });
            return;
        }
        const status = (err as { statusCode?: number }).statusCode ?? 502;
        const code = (err as { code?: string }).code ?? 'PROXY_UPSTREAM_ERROR';
        globalMetrics.recordProxyUpstreamError(status);
        await reply.code(status).send({
            error: {
                code,
                message: 'Failed to fetch upstream media'
            }
        });
        return;
    }

    const finalUrl = upstream.finalUrl || grant.url;
    const contentType =
        upstream.headers.get('content-type') ?? mimeFromUrl(finalUrl);

    if (upstream.status >= 500) {
        globalMetrics.recordProxyUpstreamError(upstream.status);
        await reply.code(502).send({
            error: {
                code: 'UPSTREAM_ERROR',
                message: `Upstream returned ${upstream.status}`
            }
        });
        return;
    }

    if (isManifestUrl(finalUrl, contentType)) {
        const maxManifest = cfg.proxyMaxManifestBytes;
        const declared = upstream.headers.get('content-length');
        if (declared) {
            const n = Number(declared);
            if (Number.isFinite(n) && n > maxManifest) {
                await reply.code(502).send({
                    error: {
                        code: 'MANIFEST_TOO_LARGE',
                        message: 'Upstream manifest exceeds size limit'
                    }
                });
                return;
            }
        }
        let buf: Buffer;
        try {
            buf = await readBodyLimited(upstream, maxManifest);
        } catch (err) {
            await reply.code(502).send({
                error: {
                    code: 'BODY_TOO_LARGE',
                    message:
                        err instanceof Error
                            ? err.message
                            : 'Upstream body too large'
                }
            });
            return;
        }
        recordEgress(ctx, finalUrl, buf.byteLength);
        const budget: GrantBudget = {
            remaining: ctx.maxGrantsPerRequest ?? 500
        };
        const rewritten = await rewriteManifest(
            buf.toString('utf8'),
            finalUrl,
            grant,
            ctx,
            publicBase,
            contentType,
            budget
        );
        const out = Buffer.from(rewritten, 'utf8');
        globalMetrics.recordProxyBytes(out.byteLength);
        await reply
            .code(upstream.status)
            .headers({
                'Content-Type': contentType,
                'Content-Length': String(out.byteLength),
                'Cache-Control': 'private, max-age=60',
                'Accept-Ranges': 'bytes'
            })
            .send(out);
        return;
    }

    const headersOut: Record<string, string> = {
        'Content-Disposition': 'inline; filename="stream"',
        'Cache-Control':
            upstream.headers.get('cache-control') ?? 'private, max-age=3600',
        'Access-Control-Expose-Headers':
            'Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified'
    };

    const acceptRanges =
        upstream.headers.get('accept-ranges') ??
        upstream.headers.get('accept-range');
    if (acceptRanges) headersOut['Accept-Ranges'] = acceptRanges;
    else headersOut['Accept-Ranges'] = 'bytes';
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) headersOut['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headersOut['Content-Range'] = contentRange;
    const lastModified = upstream.headers.get('last-modified');
    if (lastModified) headersOut['Last-Modified'] = lastModified;
    const etag = upstream.headers.get('etag');
    if (etag) headersOut['ETag'] = etag;

    if (shouldStream(finalUrl, contentType) && upstream.body) {
        // Streaming path: enforce max stream bytes while piping
        const declared = upstream.headers.get('content-length');
        if (declared) {
            const n = Number(declared);
            if (Number.isFinite(n) && n > cfg.proxyMaxStreamBytes) {
                await reply.code(502).send({
                    error: {
                        code: 'BODY_TOO_LARGE',
                        message: 'Upstream stream exceeds size limit'
                    }
                });
                return;
            }
        }

        // Phase 7 §10.4 — concurrent stream caps (per IP / user / global).
        // Held for the lifetime of the streamed response.
        let releaseStreamSlot: (() => Promise<void>) | null = null;
        if (ctx.streams) {
            try {
                releaseStreamSlot = await ctx.streams.acquire({
                    ip: clientIp(request, cfg) ?? 'unknown',
                    userId: (
                        request as unknown as {
                            authUser?: { id?: string };
                        }
                    ).authUser?.id,
                    grantId: grant.id
                });
            } catch (err) {
                if (err instanceof StreamConcurrencyError) {
                    globalMetrics.recordStreamRejection(err.reason);
                    logger.warn('Proxied stream rejected by concurrency cap', {
                        component: 'proxy',
                        reason: err.reason,
                        limit: err.limit
                    });
                    try {
                        await upstream.body.cancel();
                    } catch {
                        /* ignore */
                    }
                    reply.header('Retry-After', '5');
                    await reply.code(429).send({
                        error: {
                            code: err.code,
                            message: err.message
                        }
                    });
                    return;
                }
                throw err;
            }
        }

        globalMetrics.incrementActiveProxyStreams();
        const maxStream = cfg.proxyMaxStreamBytes;
        const webStream = upstream.body as import('stream/web').ReadableStream;
        const nodeStream = Readable.fromWeb(webStream);
        let bytesSeen = 0;
        let streamClosed = false;
        const cleanupStream = () => {
            if (!streamClosed) {
                streamClosed = true;
                globalMetrics.decrementActiveProxyStreams();
                recordEgress(ctx, finalUrl, bytesSeen);
                if (releaseStreamSlot) {
                    void releaseStreamSlot().catch(() => undefined);
                    releaseStreamSlot = null;
                }
            }
        };
        const limited = nodeStream.pipe(
            new Transform({
                transform(
                    chunk: Buffer,
                    _enc: string,
                    cb: (err?: Error | null, data?: unknown) => void
                ) {
                    bytesSeen += chunk.byteLength;
                    globalMetrics.recordProxyBytes(chunk.byteLength);
                    if (bytesSeen > maxStream) {
                        cb(new Error(`Stream exceeded limit ${maxStream}`));
                    } else {
                        cb(null, chunk);
                    }
                }
            })
        );
        // If limit exceeded, abort the reply
        limited.on('error', () => {
            cleanupStream();
            try {
                reply.raw.destroy();
            } catch {
                void 0;
            }
        });
        limited.on('close', cleanupStream);
        limited.on('end', cleanupStream);
        await reply
            .code(upstream.status)
            .headers(headersOut)
            .type(contentType)
            .send(limited);
        return;
    }

    // Buffered non-stream path (subtitles, small manifests missed etc.)
    {
        const declared2 = upstream.headers.get('content-length');
        if (declared2) {
            const n2 = Number(declared2);
            if (Number.isFinite(n2) && n2 > cfg.proxyMaxBufferBytes) {
                await reply.code(502).send({
                    error: {
                        code: 'BODY_TOO_LARGE',
                        message: 'Upstream body exceeds buffer limit'
                    }
                });
                return;
            }
        }
    }
    let buf2: Buffer;
    try {
        buf2 = await readBodyLimited(upstream, cfg.proxyMaxBufferBytes);
    } catch (err) {
        await reply.code(502).send({
            error: {
                code: 'BODY_TOO_LARGE',
                message:
                    err instanceof Error
                        ? err.message
                        : 'Upstream body too large'
            }
        });
        return;
    }
    recordEgress(ctx, finalUrl, buf2.byteLength);
    headersOut['Content-Length'] = String(buf2.byteLength);
    await reply
        .code(upstream.status)
        .headers(headersOut)
        .type(contentType)
        .send(buf2);
}

async function readBodyLimited(
    res: Response,
    maxBytes: number
): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    void 0;
                }
                throw new Error(`Body exceeded ${maxBytes} bytes`);
            }
            chunks.push(value);
        }
    }
    const out = Buffer.alloc(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}

export function registerSecureProxyRoutes(
    app: FastifyInstance,
    cfg: AppConfig,
    ctx: SecureProxyContext,
    publicBase: string
): void {
    const limiter = createRateLimiter();

    const guardRate = async (
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<boolean> => {
        const ip = clientIp(request, cfg);
        const key = rateLimitKey('proxy', undefined, ip);
        // Phase 7 §10.4 — configurable redemption quota (grants are the
        // anonymous public surface; per-IP is the enforceable scope).
        const limit = cfg.proxyRateLimitPerMin || RATE_LIMITS.proxy.limit;
        const result = limiter.take(key, limit, RATE_LIMITS.proxy.windowMs);
        reply.header('X-RateLimit-Limit', String(result.limit));
        reply.header('X-RateLimit-Remaining', String(result.remaining));
        if (!result.allowed) {
            reply.header('Retry-After', String(result.retryAfterSec));
            await reply.code(429).send({
                error: {
                    code: 'RATE_LIMITED',
                    message: 'Too many proxy requests'
                }
            });
            return false;
        }
        return true;
    };

    app.get<{ Params: { grantId: string } }>(
        '/v1/proxy/grant/:grantId',
        async (request, reply) => {
            if (!(await guardRate(request, reply))) return;

            const grantId = request.params.grantId;
            if (!grantId || grantId.length > 128) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_GRANT',
                        message: 'Invalid grant id'
                    }
                });
            }

            const grant = await ctx.grants.consume(grantId);
            if (!grant) {
                return reply.code(404).send({
                    error: {
                        code: 'GRANT_NOT_FOUND',
                        message: 'Playback grant expired, used, or unknown'
                    }
                });
            }

            return handleGrantRequest(
                grant,
                request,
                reply,
                ctx,
                cfg,
                publicBase
            );
        }
    );

    // DASH templated segments: /v1/proxy/grant/:id/* preserves $Number$ etc.
    app.get<{ Params: { grantId: string; '*': string } }>(
        '/v1/proxy/grant/:grantId/*',
        async (request, reply) => {
            if (!(await guardRate(request, reply))) return;
            const grantId = request.params.grantId;
            const suffix = (request.params as { '*': string })['*'] ?? '';
            if (!grantId || grantId.length > 128) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_GRANT',
                        message: 'Invalid grant id'
                    }
                });
            }
            const grant = await ctx.grants.get(grantId);
            // For templated DASH, we use get (not consume) so base grant is reusable for many segments
            if (!grant) {
                return reply.code(404).send({
                    error: {
                        code: 'GRANT_NOT_FOUND',
                        message: 'Playback grant expired or unknown'
                    }
                });
            }
            // Construct concrete upstream URL by appending suffix to grant base
            // Grant for DASH base is a directory URL ending with /
            let upstreamUrl: string;
            try {
                const base = grant.url.endsWith('/')
                    ? grant.url
                    : `${grant.url}/`;
                upstreamUrl = new URL(suffix, base).toString();
            } catch {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_REQUEST',
                        message: 'Invalid segment path'
                    }
                });
            }
            const templatedGrant: typeof grant = { ...grant, url: upstreamUrl };
            return handleGrantRequest(
                templatedGrant,
                request,
                reply,
                ctx,
                cfg,
                publicBase,
                // DASH segment fetches draw from the segment pool (§10.1).
                { segment: true }
            );
        }
    );

    // NOTE: a wildcard is required here — Fastify's default maxParamLength
    // (100) rejects realistic compact tokens (~300+ chars) with
    // FST_ERR_MAX_PARAM_LENGTH before the handler can run. Wildcard segments
    // are not subject to that limit, so the token is bounded and validated
    // here instead (single segment, <= 4096 chars).
    app.get<{ Params: { '*': string } }>(
        '/v1/proxy/token/*',
        async (request, reply) => {
            if (!(await guardRate(request, reply))) return;

            const token = decodeURIComponent(request.params['*'] ?? '');
            if (!token || token.length > 4096 || token.includes('/')) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_TOKEN',
                        message: 'Invalid playback token'
                    }
                });
            }

            const grant = ctx.grants.verifySignedToken(token);
            if (!grant) {
                return reply.code(404).send({
                    error: {
                        code: 'GRANT_NOT_FOUND',
                        message: 'Playback token expired or invalid'
                    }
                });
            }
            // Prefer consume by id when present in store (honours single-use).
            const live = await ctx.grants.consume(grant.id);
            const effective = live ?? grant;

            return handleGrantRequest(
                effective,
                request,
                reply,
                ctx,
                cfg,
                publicBase
            );
        }
    );

    /**
     * Block the legacy open proxy (`GET /v1/proxy?data=...`) whenever secure
     * proxy mode is on. The framework still registers the route; this
     * onRequest hook short-circuits it before the controller runs.
     */
    if (cfg.secureProxy) {
        app.addHook('onRequest', async (request, reply) => {
            const url = request.url ?? '';
            const pathOnly = url.split('?')[0];
            if (pathOnly === '/v1/proxy' && request.method === 'GET') {
                const q = request.query as { data?: string } | undefined;
                if (q?.data != null) {
                    await reply.code(403).send({
                        error: {
                            code: 'LEGACY_PROXY_DISABLED',
                            message:
                                'Arbitrary proxy payloads are disabled. Use short-lived playback grants issued by the server.'
                        }
                    });
                }
            }
        });
    }
}
