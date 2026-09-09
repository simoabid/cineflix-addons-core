/**
 * Federation tests (Phase 12 §15.3 — multi-backend aggregation).
 *
 * Unit tests over the FederationService against local fake OMSS backends
 * (namespacing, global dedup, failure accounting, status diagnostics), plus
 * route tests over the real compiled handlers with a dev config (fail-closed
 * when disabled, validation, auth guards).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';

import { startHttpServer, devConfig } from './helpers/harness.js';
import { FederationService } from '../dist/federation/service.js';
import { registerFederationRoutes } from '../dist/routes/federation.routes.js';
import { globalReliability } from '../dist/reliability/circuit.js';

/**
 * Dev SSRF policy matching the server wiring for dev configs
 * (allowHttpUpstreams + loopback suffix exemption) so the local fake
 * backends on 127.0.0.1 are reachable, as in test/helpers/harness.js.
 */
const DEV_POLICY = {
    allowHttp: true,
    allowHostSuffixes: ['127.0.0.1'],
    allowCredentials: false,
    maxLength: 2048
};

// ── Fake OMSS backend ────────────────────────────────────────────────────────

/** Serves OMSS-style source responses; `sources` can vary per path. */
async function startFakeBackend(handlers) {
    return startHttpServer((req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.url.startsWith('/v1/movies/') && handlers.movie) {
            return send(200, { sources: handlers.movie });
        }
        if (handlers.tv && /\/v1\/tv\//.test(req.url)) {
            return send(200, { sources: handlers.tv });
        }
        return send(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
    });
}

describe('FederationService', () => {
    let healthy;
    let mirror;
    let broken;

    before(async () => {
        const srcA = {
            url: 'https://cdn.example/video-a.mp4',
            type: 'movie',
            quality: '1080p',
            provider: { id: 'whatever', name: 'Remote A' }
        };
        const srcB = {
            url: 'https://cdn.example/video-b.mp4',
            type: 'movie',
            quality: '720p',
            provider: { id: 'whatever', name: 'Remote B' }
        };
        healthy = await startFakeBackend({ movie: [srcA] });
        // Mirror serves the SAME url as healthy → must be deduped.
        mirror = await startFakeBackend({ movie: [srcA, srcB] });
        // Broken: server that hangs then resets.
        broken = await startHttpServer((req, res) => {
            res.destroy();
        });
    });

    after(async () => {
        await healthy.close();
        await mirror.close();
        await broken.close();
    });

    test('namespaces provider ids and dedups sources across backends', async () => {
        const svc = new FederationService(
            [
                {
                    name: 'primary',
                    baseUrl: healthy.baseUrl,
                    priority: 1,
                    token: 'secret-token'
                },
                {
                    name: 'mirror',
                    baseUrl: mirror.baseUrl,
                    priority: 2
                }
            ],
            10_000,
            DEV_POLICY
        );
        const result = await svc.fetchSources({
            type: 'movie',
            omdbId: 'tmdb:550'
        });
        assert.equal(result.backendsQueried, 2);
        assert.equal(result.duplicatesDropped, 1);
        assert.equal(result.sources.length, 2);
        const ids = result.sources.map((s) => s.provider.id).sort();
        assert.deepEqual(ids, ['backend:mirror', 'backend:primary']);
        assert.equal(result.sources[0].provider.id, 'backend:primary');
        assert.equal(result.sources[0].provider.name, 'Remote A (federated)');
    });

    test('failed backend is recorded without aborting the others', async () => {
        const svc = new FederationService(
            [
                { name: 'dead', baseUrl: broken.baseUrl, priority: 1 },
                { name: 'alive', baseUrl: healthy.baseUrl, priority: 2 }
            ],
            10_000,
            DEV_POLICY
        );
        const result = await svc.fetchSources({
            type: 'movie',
            omdbId: 'tmdb:550'
        });
        assert.equal(result.backendsQueried, 1);
        assert.deepEqual(
            result.backendsFailed.map((f) => f.backendId),
            ['backend:dead']
        );
        assert.equal(result.sources.length, 1);
        // The failure was recorded in the shared reliability registry.
        assert.ok(globalReliability.getState('backend:dead'));
    });

    test('status reports per-backend circuit, budget, and token state', async () => {
        const svc = new FederationService(
            [
                {
                    name: 'primary',
                    baseUrl: healthy.baseUrl,
                    priority: 1,
                    token: 't'
                },
                { name: 'open2', baseUrl: broken.baseUrl, priority: 2 }
            ],
            10_000,
            DEV_POLICY
        );
        // Failures trip the circuit for open2 (threshold 5).
        for (let i = 0; i < 5; i++) {
            await svc
                .fetchSources({ type: 'movie', omdbId: 'tmdb:550' })
                .catch(() => {});
        }
        const status = svc.getStatus();
        assert.equal(status.length, 2);
        const open = status.find((b) => b.id === 'backend:open2');
        const primary = status.find((b) => b.id === 'backend:primary');
        assert.ok(open);
        assert.ok(primary);
        assert.equal(primary.hasToken, true);
        assert.equal(open.hasToken, false);
        assert.equal(open.circuit, 'open');
    });

    test('disabled service (no backends) returns empty results', async () => {
        const svc = new FederationService([]);
        assert.equal(svc.enabled, false);
        const result = await svc.fetchSources({
            type: 'movie',
            omdbId: 'tmdb:550'
        });
        assert.deepEqual(result.sources, []);
        assert.equal(result.backendsQueried, 0);
    });
});

// ── Routes ───────────────────────────────────────────────────────────────────

describe('federation routes', () => {
    test('fail-closed when disabled; invalid ids rejected', async () => {
        const cfg = devConfig({
            federationEnabled: false,
            federationBackends: [],
            authMode: 'disabled'
        });
        const app = fastify();
        registerFederationRoutes(
            app,
            cfg,
            new FederationService(
                cfg.federationBackends,
                cfg.federationTimeoutMs,
                cfg.federationEnabled ? DEV_POLICY : undefined
            )
        );
        await app.ready();

        // Disabled → movie route returns an empty merged result.
        const res = await app.inject({
            method: 'GET',
            url: '/v1/federation/movies/tmdb:550/sources'
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json().sources, []);
        assert.equal(res.json().backendsQueried, 0);

        // Invalid media id → 400.
        const bad = await app.inject({
            method: 'GET',
            url: '/v1/federation/movies/not-an-id/sources'
        });
        assert.equal(bad.statusCode, 400);
        assert.equal(bad.json().error.code, 'INVALID_TMDB_ID');

        await app.close();
    });

    test('merges sources from configured backends through the route', async () => {
        const backend = await startFakeBackend({
            movie: [
                {
                    url: 'https://cdn.example/fed.mp4',
                    type: 'movie',
                    quality: '1080p',
                    provider: { id: 'x', name: 'Fed' }
                }
            ]
        });
        const cfg = devConfig({
            federationEnabled: true,
            federationBackends: [
                { name: 'edge', baseUrl: backend.baseUrl, priority: 1 }
            ],
            authMode: 'disabled'
        });
        const app = fastify();
        registerFederationRoutes(
            app,
            cfg,
            new FederationService(
                cfg.federationBackends,
                cfg.federationTimeoutMs,
                cfg.federationEnabled ? DEV_POLICY : undefined
            )
        );
        await app.ready();

        const res = await app.inject({
            method: 'GET',
            url: '/v1/federation/movies/tmdb:550/sources'
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.backendsQueried, 1);
        assert.equal(body.sources.length, 1);
        assert.equal(body.sources[0].provider.id, 'backend:edge');

        const status = await app.inject({
            method: 'GET',
            url: '/v1/federation/status'
        });
        assert.equal(status.statusCode, 200);
        assert.equal(status.json().enabled, true);

        await app.close();
        await backend.close();
    });
});
