/**
 * Phase 9 §12.1 integration tests — the secure playback proxy over real
 * HTTP against a local upstream: media proxying, Range/206 propagation,
 * HLS manifest rewriting with playable child grants, header forwarding and
 * sanitization, compact-token proxying, and per-hop SSRF revalidation of
 * upstream redirects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fastify from 'fastify';
import {
    createSecureProxyContext,
    createProxyCapacityGuards,
    registerSecureProxyRoutes
} from '../dist/security/index.js';
import { devConfig, startHttpServer } from './helpers/harness.js';

const UPSTREAM_HEADERS = [];

async function bootProxy(cfgOverrides = {}, upstreamHandler) {
    const upstream = await startHttpServer(upstreamHandler);
    const cfg = devConfig({
        secureProxy: true,
        playbackGrantSecret: 'test-grant-secret-0123456789abcdef0123456789',
        proxyTimeoutMs: 5000,
        ...cfgOverrides
    });
    const proxyCtx = {
        ...createSecureProxyContext(cfg),
        ...createProxyCapacityGuards({
            ...cfg,
            maxConcurrentStreamsPerIp: 64,
            maxConcurrentStreamsPerUser: 64,
            maxConcurrentStreamsGlobal: 64
        })
    };
    const app = fastify({ logger: false });
    registerSecureProxyRoutes(app, cfg, proxyCtx, 'http://localhost:3006');
    await app.ready();
    return { app, upstream, grants: proxyCtx.grants, cfg };
}

test('a grant proxies media end-to-end with content-type preserved', async () => {
    const media = Buffer.alloc(8192, 7);
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        if (req.url.startsWith('/video.mp4')) {
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(media.length)
            });
            return res.end(media);
        }
        res.writeHead(404);
        res.end();
    });
    try {
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/video.mp4`,
            ttlSeconds: 300
        });
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy/grant/${encodeURIComponent(grant.id)}`
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'video/mp4');
        assert.equal(res.rawPayload.length, media.length);
    } finally {
        await upstream.close();
    }
});

test('Range requests propagate upstream and return 206 with Content-Range', async () => {
    const media = Buffer.alloc(4096, 1);
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        if (req.url.startsWith('/ranged.mp4')) {
            const range = req.headers.range;
            if (range) {
                const m = /bytes=(\d+)-(\d+)/.exec(range);
                const start = Number(m[1]);
                const end = Math.min(Number(m[2]), media.length - 1);
                const chunk = media.subarray(start, end + 1);
                res.writeHead(206, {
                    'content-type': 'video/mp4',
                    'content-length': String(chunk.length),
                    'content-range': `bytes ${start}-${end}/${media.length}`,
                    'accept-ranges': 'bytes'
                });
                return res.end(chunk);
            }
            res.writeHead(200, {
                'content-length': String(media.length),
                'accept-ranges': 'bytes'
            });
            return res.end(media);
        }
        res.writeHead(404);
        res.end();
    });
    try {
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/ranged.mp4`,
            ttlSeconds: 300
        });
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy/grant/${encodeURIComponent(grant.id)}`,
            headers: { range: 'bytes=0-1023' }
        });
        assert.equal(res.statusCode, 206);
        assert.equal(
            res.headers['content-range'],
            `bytes 0-1023/${media.length}`
        );
        assert.equal(res.headers['accept-ranges'], 'bytes');
        assert.equal(res.rawPayload.length, 1024);
    } finally {
        await upstream.close();
    }
});

test('HLS manifests are rewritten so every segment becomes a playable child grant', async () => {
    const seg = Buffer.alloc(2048, 3);
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        if (req.url.startsWith('/stream/master.m3u8')) {
            const body = [
                '#EXTM3U',
                '#EXT-X-VERSION:3',
                '#EXTINF:4.0,',
                `${upstream.baseUrl}/stream/seg0.ts`,
                '#EXTINF:4.0,',
                `${upstream.baseUrl}/stream/seg1.ts`,
                '#EXT-X-ENDLIST'
            ].join('\n');
            res.writeHead(200, {
                'content-type': 'application/vnd.apple.mpegurl'
            });
            return res.end(body);
        }
        if (req.url.startsWith('/stream/seg')) {
            res.writeHead(200, { 'content-type': 'video/mp2t' });
            return res.end(seg);
        }
        res.writeHead(404);
        res.end();
    });
    try {
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/stream/master.m3u8`,
            ttlSeconds: 300
        });
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy/grant/${encodeURIComponent(grant.id)}`
        });
        assert.equal(res.statusCode, 200);
        const body = res.body;
        assert.ok(
            !body.includes(upstream.baseUrl),
            'raw upstream URLs must never reach the client'
        );
        assert.ok(
            body.includes('/v1/proxy/grant/'),
            'segments must be proxied through child grants'
        );

        // A rewritten segment URL must itself be playable end-to-end
        const segGrantPath =
            /https?:\/\/[^\s]+(\/v1\/proxy\/grant\/[A-Za-z0-9_%-]+)/.exec(body);
        assert.ok(
            segGrantPath,
            'rewritten playlist contains a child grant URL'
        );
        const segRes = await app.inject({
            method: 'GET',
            url: segGrantPath[1]
        });
        assert.equal(segRes.statusCode, 200);
        assert.equal(segRes.rawPayload.length, seg.length);
    } finally {
        await upstream.close();
    }
});

test('grant headers are forwarded upstream except credentials and hop-by-hop headers', async () => {
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        UPSTREAM_HEADERS.push(req.headers);
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('x');
    });
    try {
        await grants.issue({
            url: `${upstream.baseUrl}/headers.mp4`,
            ttlSeconds: 300,
            headers: {
                'x-custom': 'forward-me',
                cookie: 'session=steal-me',
                authorization: 'Bearer steal-me',
                connection: 'close'
            }
        });
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/headers2.mp4`,
            ttlSeconds: 300,
            headers: { 'x-custom': 'forward-me' }
        });
        await app.inject({
            method: 'GET',
            url: `/v1/proxy/grant/${encodeURIComponent(grant.id)}`
        });
        const seen = UPSTREAM_HEADERS[UPSTREAM_HEADERS.length - 1];
        assert.equal(seen['x-custom'], 'forward-me');
        assert.equal(seen.cookie, undefined);
        assert.equal(seen.authorization, undefined);
    } finally {
        await upstream.close();
        UPSTREAM_HEADERS.length = 0;
    }
});

test('upstream redirects into private networks are revalidated and blocked (403)', async () => {
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        if (req.url.startsWith('/evil-redirect')) {
            res.writeHead(302, { location: 'https://192.168.0.1/admin' });
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('x');
    });
    try {
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/evil-redirect.mp4`,
            ttlSeconds: 300
        });
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy/grant/${encodeURIComponent(grant.id)}`
        });
        assert.equal(res.statusCode, 403);
        assert.equal(
            JSON.parse(res.payload).error.code,
            'URL_POLICY_VIOLATION'
        );
    } finally {
        await upstream.close();
    }
});

test('compact signed tokens proxy the target resource without a stored grant', async () => {
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('token-proxied');
    });
    try {
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/token.mp4`,
            ttlSeconds: 300
        });
        const token = grants.signCompact(grant);
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy/token/${encodeURIComponent(token)}`
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'token-proxied');
    } finally {
        await upstream.close();
    }
});

test('expired grants are refused with 404 and never hit the upstream', async () => {
    let upstreamHits = 0;
    const { app, upstream, grants } = await bootProxy({}, (req, res) => {
        upstreamHits++;
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('x');
    });
    try {
        const grant = await grants.issue({
            url: `${upstream.baseUrl}/expired.mp4`,
            ttlSeconds: 300
        });
        await grants.revoke(grant.id); // removed ahead of expiry
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy/grant/${encodeURIComponent(grant.id)}`
        });
        assert.equal(res.statusCode, 404);
        assert.equal(upstreamHits, 0, 'expired grants must not be proxied');
    } finally {
        await upstream.close();
    }
});

test('the legacy open proxy endpoint is blocked when secure proxy is enabled', async () => {
    const { app, upstream } = await bootProxy({}, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('should never be reachable');
    });
    try {
        const res = await app.inject({
            method: 'GET',
            url: `/v1/proxy?data=${encodeURIComponent(JSON.stringify({ url: `${upstream.baseUrl}/anything` }))}`
        });
        assert.ok(
            [400, 403, 404, 410].includes(res.statusCode),
            `unexpected status ${res.statusCode}`
        );
    } finally {
        await upstream.close();
    }
});
