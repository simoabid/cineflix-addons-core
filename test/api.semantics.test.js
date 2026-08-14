import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerAddonRoutes } from '../dist/routes/addons.routes.js';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { loadConfig } from '../dist/config.js';

const testFile = path.resolve('./data/test-semantics.json');

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

test('GET /v1/addons supports search, capability filtering, sorting, and pagination', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();

    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    // Install multiple mock addons
    await storage.saveAddon({
        providerId: 'addon:alpha',
        slug: 'alpha',
        name: 'Alpha Streamer',
        manifestUrl: 'https://alpha.example/manifest.json',
        baseUrl: 'https://alpha.example',
        enabled: true,
        order: 1,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'alpha', name: 'Alpha', version: '1.0', resources: ['stream'], types: ['movie'], catalogs: [] },
        capabilities: { stream: true, subtitles: false, catalog: false, meta: false, status: 'operational' },
        health: { healthy: true, lastChecked: new Date().toISOString() },
        addedAt: new Date(Date.now() - 10000).toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    await storage.saveAddon({
        providerId: 'addon:beta',
        slug: 'beta',
        name: 'Beta Subtitles',
        manifestUrl: 'https://beta.example/manifest.json',
        baseUrl: 'https://beta.example',
        enabled: true,
        order: 0,
        timeoutMs: 3000,
        source: 'manual',
        manifest: { id: 'beta', name: 'Beta', version: '1.0', resources: ['subtitles'], types: ['movie'], catalogs: [] },
        capabilities: { stream: false, subtitles: true, catalog: false, meta: false, status: 'operational' },
        health: { healthy: false, lastChecked: new Date().toISOString(), error: 'timeout' },
        addedAt: new Date(Date.now() - 5000).toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    await manager.init();

    const app = fastify();
    registerAddonRoutes(app, manager, cfg, undefined, undefined, storage);

    // 1. Pagination & Envelope
    const resAll = await app.inject({ method: 'GET', url: '/v1/addons?page=1&limit=10' });
    assert.equal(resAll.statusCode, 200);
    const bodyAll = JSON.parse(resAll.body);
    assert.equal(bodyAll.pagination.total, 2);
    assert.equal(bodyAll.pagination.page, 1);
    assert.equal(bodyAll.pagination.limit, 10);
    assert.equal(bodyAll.addons.length, 2);
    assert.ok(resAll.headers['etag']);

    // 2. Search filter
    const resSearch = await app.inject({ method: 'GET', url: '/v1/addons?search=alpha' });
    const bodySearch = JSON.parse(resSearch.body);
    assert.equal(bodySearch.addons.length, 1);
    assert.equal(bodySearch.addons[0].id, 'addon:alpha');

    // 3. Capability filter
    const resCap = await app.inject({ method: 'GET', url: '/v1/addons?capability=subtitles' });
    const bodyCap = JSON.parse(resCap.body);
    assert.equal(bodyCap.addons.length, 1);
    assert.equal(bodyCap.addons[0].id, 'addon:beta');

    // 4. Health filter
    const resHealth = await app.inject({ method: 'GET', url: '/v1/addons?health=unhealthy' });
    const bodyHealth = JSON.parse(resHealth.body);
    assert.equal(bodyHealth.addons.length, 1);
    assert.equal(bodyHealth.addons[0].id, 'addon:beta');

    // 5. Sorting by order
    const resSort = await app.inject({ method: 'GET', url: '/v1/addons?sort=order&direction=asc' });
    const bodySort = JSON.parse(resSort.body);
    assert.equal(bodySort.addons[0].id, 'addon:beta'); // order 0
    assert.equal(bodySort.addons[1].id, 'addon:alpha'); // order 1

    await cleanup();
});

test('PATCH and DELETE mutations enforce optimistic concurrency (If-Match)', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();
    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    await storage.saveAddon({
        providerId: 'addon:opt-test',
        slug: 'opt-test',
        name: 'Opt Test',
        manifestUrl: 'https://test.example/manifest.json',
        baseUrl: 'https://test.example',
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'opt-test', name: 'Opt', version: '1.0', resources: ['stream'], types: ['movie'], catalogs: [] },
        version: 1,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    await manager.init();

    const app = fastify();
    registerAddonRoutes(app, manager, cfg, undefined, undefined, storage);

    const currentRev = manager.getRevision();

    // 1. Mismatched If-Match revision -> 412 Precondition Failed
    const resMismatch = await app.inject({
        method: 'PATCH',
        url: '/v1/addons/addon:opt-test',
        headers: { 'If-Match': `"rev-${currentRev + 99}"` },
        payload: { timeoutMs: 7000 }
    });
    assert.equal(resMismatch.statusCode, 412);
    const bodyMismatch = JSON.parse(resMismatch.body);
    assert.equal(bodyMismatch.error.code, 'PRECONDITION_FAILED');

    // 2. Correct If-Match revision -> 200 OK with new revision
    const resMatch = await app.inject({
        method: 'PATCH',
        url: '/v1/addons/addon:opt-test',
        headers: { 'If-Match': `"rev-${currentRev}"` },
        payload: { timeoutMs: 7000 }
    });
    assert.equal(resMatch.statusCode, 200);
    const bodyMatch = JSON.parse(resMatch.body);
    assert.equal(bodyMatch.ok, true);
    assert.equal(bodyMatch.addon.timeoutMs, 7000);
    assert.ok(bodyMatch.revision > currentRev);

    await cleanup();
});

test('POST /v1/debrid/transfers validates and respects fileIdx, title, sources, and maxWaitSec', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();

    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    let enqueuedJobPayload = null;
    const mockJobEngine = {
        enqueue: async (type, payload) => {
            enqueuedJobPayload = payload;
            return {
                id: 'job_transfer_test_123',
                type,
                status: 'queued',
                payload
            };
        }
    };

    const app = fastify();
    registerAddonRoutes(app, manager, cfg, undefined, undefined, storage, undefined, mockJobEngine);

    const res = await app.inject({
        method: 'POST',
        url: '/v1/debrid/transfers',
        payload: {
            infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
            fileIdx: 4,
            title: 'Fight Club 1080p BluRay',
            sources: ['https://stream.example/fightclub.mkv'],
            maxWaitSec: 300,
            season: 1,
            episode: 2
        }
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.jobId, 'job_transfer_test_123');

    assert.ok(enqueuedJobPayload);
    assert.equal(enqueuedJobPayload.fileIdx, 4);
    assert.equal(enqueuedJobPayload.title, 'Fight Club 1080p BluRay');
    assert.deepEqual(enqueuedJobPayload.sources, ['https://stream.example/fightclub.mkv']);
    assert.equal(enqueuedJobPayload.maxWaitSec, 300);
    assert.equal(enqueuedJobPayload.season, 1);
    assert.equal(enqueuedJobPayload.episode, 2);

    await cleanup();
});
