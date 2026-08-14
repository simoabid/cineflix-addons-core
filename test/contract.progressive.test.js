import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listProvidersWithPriority } from '../dist/progressiveScrape.js';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { loadConfig } from '../dist/config.js';
import { tmdbIdValidator, providerIdValidator } from '../dist/validation/schemas.js';
import { formatValidationError } from '../dist/validation/validator.js';

const testFile = path.resolve('./data/test-contract-prog.json');
const fixturePath = path.resolve('./test/fixtures/contracts');

async function cleanup() {
    try { await fs.unlink(testFile); } catch { /* ignore */ }
}

function createMockRegistry() {
    const map = new Map();
    return {
        register: (p) => map.set(p.id, p),
        unregister: (id) => map.delete(id),
        getProvider: (id) => map.get(id),
        getProviders: () => Array.from(map.values()),
        listProviders: () => Array.from(map.keys()),
        hasProvider: (id) => map.has(id)
    };
}

async function buildTestApp() {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();

    await storage.saveAddon({
        providerId: 'addon:torrentio',
        slug: 'torrentio',
        name: 'Torrentio',
        manifestUrl: 'https://torrentio.strem.fun/manifest.json',
        baseUrl: 'https://torrentio.strem.fun',
        enabled: true,
        order: 0,
        timeoutMs: 8000,
        source: 'manual',
        manifest: { id: 'torrentio', name: 'Torrentio', version: '1.0.0', resources: ['stream'], types: ['movie', 'series'], catalogs: [] },
        capabilities: { stream: true, subtitles: false, catalog: false, meta: false, status: 'operational' },
        health: { healthy: true, lastChecked: new Date().toISOString() },
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    const app = fastify({ logger: false });

    app.get('/v1/providers', async (_req, reply) => {
        const providers = listProvidersWithPriority(manager);
        return reply.code(200).send(providers);
    });

    app.get('/v1/movies/:tmdbId/providers/:providerId', async (req, reply) => {
        const tVal = tmdbIdValidator(req.params.tmdbId);
        if (!tVal.ok && tVal.errors) {
            return reply.code(400).send(formatValidationError(tVal.errors, req.id));
        }
        const pVal = providerIdValidator(req.params.providerId);
        if (!pVal.ok && pVal.errors) {
            return reply.code(400).send(formatValidationError(pVal.errors, req.id));
        }
        const addon = manager.get(pVal.data);
        if (!addon) {
            return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Provider not found' } });
        }
        return reply.code(200).send({
            sources: [
                {
                    id: 'src_prog_1',
                    name: 'Torrentio 1080p',
                    title: 'Fight Club 1999 1080p BluRay',
                    url: 'https://stream.example/fight_club.mkv',
                    quality: '1080p',
                    type: 'direct',
                    format: 'mkv',
                    size: 2147483648,
                    providerId: addon.providerId,
                    addonName: addon.name
                }
            ],
            subtitles: [],
            diagnostics: [{ providerId: addon.providerId, latencyMs: 120, status: 'ok' }],
            providerId: addon.providerId,
            providerName: addon.name,
            durationMs: 120,
            revision: manager.getRevision()
        });
    });

    await app.ready();
    return { app, manager };
}

test('progressive single-provider live app.inject matches contract shape', async () => {
    const { app } = await buildTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'progressive-provider-response.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({
        method: 'GET',
        url: '/v1/movies/550/providers/addon:torrentio'
    });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.sources));
    assert.ok(Array.isArray(body.subtitles));
    assert.ok(Array.isArray(body.diagnostics));
    assert.equal(body.providerId, fixture.expectedShape.providerId);
    assert.equal(body.providerName, fixture.expectedShape.providerName);
    assert.equal(typeof body.durationMs, 'number');
    assert.equal(typeof body.revision, 'number');
});

test('GET /v1/providers live app.inject exposes capability, freshness, and diagnostics', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/providers' });
    assert.equal(res.statusCode, 200);

    const providers = JSON.parse(res.payload);
    assert.ok(Array.isArray(providers));
    assert.equal(providers.length, 1);

    const p = providers[0];
    assert.equal(p.id, 'addon:torrentio');
    assert.equal(p.name, 'Torrentio');
    assert.equal(p.enabled, true);
    assert.equal(p.admissionState, 'validated');
    assert.ok(p.capabilities);
    assert.ok(p.health);
    assert.equal(p.health.healthy, true);
    assert.equal(p.health.isFresh, true);
    assert.ok(p.diagnostics);
    assert.equal(p.diagnostics.circuitState, 'closed');
});
