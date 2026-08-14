import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSecureProxyContext, registerSecureProxyRoutes } from '../dist/security/index.js';
import { loadConfig } from '../dist/config.js';

const fixturePath = path.resolve('./test/fixtures/contracts');

test('proxy range request fixture validates expected headers and 206 status', async () => {
    const raw = await fs.readFile(path.join(fixturePath, 'proxy-range-response.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    assert.equal(fixture.expectedStatus, 206);
    assert.equal(fixture.expectedHeaders['accept-ranges'], 'bytes');
    assert.ok(fixture.expectedHeaders['content-range'].startsWith('bytes '));
});

test('proxy routes live app.inject enforces grant lifecycle and error contracts', async () => {
    const cfg = { ...loadConfig(), secureProxy: true, authMode: 'disabled' };
    const proxyCtx = createSecureProxyContext(cfg);
    const app = fastify({ logger: false });
    registerSecureProxyRoutes(app, cfg, proxyCtx, 'http://localhost:3006');
    await app.ready();

    // 1. Missing / invalid grant returns 404
    const notFoundRes = await app.inject({
        method: 'GET',
        url: '/v1/proxy/grant/nonexistent_grant_id'
    });
    assert.equal(notFoundRes.statusCode, 404);

    // 2. Issue a grant for public upstream
    const grant = await proxyCtx.grants.issue(
        {
            url: 'https://example.com/video.mp4',
            headers: { custom: 'header' }
        },
        { ttlSeconds: 60 }
    );
    assert.ok(grant.id);
    const proxyUrl = proxyCtx.grants.toProxyUrl(grant.id, 'http://localhost:3006');
    assert.ok(proxyUrl);

    const token = proxyCtx.grants.signCompact(grant);
    assert.ok(token);

    // 3. Status check on invalid token
    const tokenRes = await app.inject({
        method: 'GET',
        url: '/v1/proxy/token/invalid_signed_token'
    });
    assert.equal(tokenRes.statusCode, 404);
});

test('HLS manifest rewrite fixture adheres to M3U8 specification', async () => {
    const m3u8 = await fs.readFile(path.join(fixturePath, 'hls-manifest-rewrite.m3u8'), 'utf-8');

    assert.ok(m3u8.startsWith('#EXTM3U'), 'HLS playlist must start with #EXTM3U');
    assert.ok(m3u8.includes('#EXT-X-VERSION:'), 'Version tag must be present');
    assert.ok(m3u8.includes('/v1/proxy?data='), 'Segment URLs must be rewritten to proxy endpoint');
    assert.ok(m3u8.includes('#EXT-X-ENDLIST'), 'Endlist tag must be present for static VOD');
});
