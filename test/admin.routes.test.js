import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerAddonRoutes } from '../dist/routes/addons.routes.js';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { globalReliability } from '../dist/reliability/circuit.js';
import { loadConfig } from '../dist/config.js';

const testFile = path.resolve('./data/test-admin-routes.json');

async function cleanup() {
    try {
        await fs.unlink(testFile);
    } catch {
        /* ignore */
    }
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

test('POST /v1/quarantine/:providerId manually quarantines and POST /release releases', async () => {
    await cleanup();
    const cfg = {
        ...loadConfig(),
        authMode: 'disabled',
        quarantineEnabled: true
    };
    const storage = new FileStorageBackend(testFile);
    await storage.init();

    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    await storage.saveAddon({
        providerId: 'addon:quarantinetest',
        slug: 'quarantinetest',
        name: 'Quarantine Test Addon',
        manifestUrl: 'https://example.com/manifest.json',
        baseUrl: 'https://example.com',
        enabled: true,
        order: 1,
        timeoutMs: 5000,
        source: 'url',
        manifest: {
            id: 'quarantinetest',
            name: 'Quarantine Test',
            version: '1.0',
            resources: ['stream'],
            types: ['movie'],
            catalogs: []
        },
        capabilities: {
            stream: true,
            subtitles: false,
            catalog: false,
            meta: false,
            status: 'operational'
        },
        health: { healthy: true, lastChecked: new Date().toISOString() },
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    await manager.init();

    const app = fastify();
    registerAddonRoutes(app, manager, cfg, undefined, undefined, storage);

    // 1. Stale If-Match rejects with 412
    const staleRes = await app.inject({
        method: 'POST',
        url: '/v1/quarantine/addon:quarantinetest',
        headers: { 'If-Match': '"rev-999"' },
        payload: { reason: 'Flaky upstream', ttlMs: 60000 }
    });
    assert.equal(staleRes.statusCode, 412);

    // 2. Manual quarantine with matching or omitted If-Match succeeds
    const currentRev = manager.getRevision();
    const qRes = await app.inject({
        method: 'POST',
        url: '/v1/quarantine/addon:quarantinetest',
        headers: { 'If-Match': `"rev-${currentRev}"` },
        payload: { reason: 'Flaky upstream', ttlMs: 60000 }
    });

    assert.equal(qRes.statusCode, 200);
    const qBody = qRes.json();
    assert.equal(qBody.ok, true);
    assert.equal(qBody.quarantined, 'addon:quarantinetest');
    assert.equal(qBody.reason, 'Flaky upstream');
    assert.equal(globalReliability.isQuarantined('addon:quarantinetest'), true);

    // 3. GET /v1/quarantine lists the quarantined provider
    const listRes = await app.inject({
        method: 'GET',
        url: '/v1/quarantine'
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json();
    assert.ok(
        listBody.quarantined.some(
            (q) => q.providerId === 'addon:quarantinetest'
        )
    );

    // 4. Release quarantine
    const relRes = await app.inject({
        method: 'POST',
        url: '/v1/quarantine/addon:quarantinetest/release'
    });
    assert.equal(relRes.statusCode, 200);
    assert.equal(
        globalReliability.isQuarantined('addon:quarantinetest'),
        false
    );

    await cleanup();
});

test('POST /v1/addons/:providerId/probe runs probe with optimistic concurrency check', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();

    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    await storage.saveAddon({
        providerId: 'addon:probetest',
        slug: 'probetest',
        name: 'Probe Test Addon',
        manifestUrl: 'https://example.com/manifest.json',
        baseUrl: 'https://example.com',
        enabled: true,
        order: 1,
        timeoutMs: 5000,
        source: 'url',
        manifest: {
            id: 'probetest',
            name: 'Probe Test',
            version: '1.0',
            resources: ['stream'],
            types: ['movie'],
            catalogs: []
        },
        capabilities: {
            stream: true,
            subtitles: false,
            catalog: false,
            meta: false,
            status: 'operational'
        },
        health: { healthy: true, lastChecked: new Date().toISOString() },
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    await manager.init();

    const app = fastify();
    registerAddonRoutes(app, manager, cfg, undefined, undefined, storage);

    // Stale If-Match returns 412
    const staleRes = await app.inject({
        method: 'POST',
        url: '/v1/addons/addon:probetest/probe',
        headers: { 'If-Match': '"rev-999"' }
    });
    assert.equal(staleRes.statusCode, 412);

    // Matching probe succeeds
    const probeRes = await app.inject({
        method: 'POST',
        url: '/v1/addons/addon:probetest/probe'
    });

    assert.equal(probeRes.statusCode, 200);
    const probeBody = probeRes.json();
    assert.equal(probeBody.providerId, 'addon:probetest');
    assert.ok(typeof probeBody.latencyMs === 'number');
    assert.ok(typeof probeBody.healthy === 'boolean');
    assert.ok(probeBody.health);

    await cleanup();
});

test('DELETE /v1/addons/:providerId accepts audit reason and records it', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();

    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    await storage.saveAddon({
        providerId: 'addon:deletetest',
        slug: 'deletetest',
        name: 'Delete Test Addon',
        manifestUrl: 'https://example.com/manifest.json',
        baseUrl: 'https://example.com',
        enabled: true,
        order: 1,
        timeoutMs: 5000,
        source: 'url',
        manifest: {
            id: 'deletetest',
            name: 'Delete Test',
            version: '1.0',
            resources: ['stream'],
            types: ['movie'],
            catalogs: []
        },
        capabilities: {
            stream: true,
            subtitles: false,
            catalog: false,
            meta: false,
            status: 'operational'
        },
        health: { healthy: true, lastChecked: new Date().toISOString() },
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    await manager.init();

    const app = fastify();
    registerAddonRoutes(app, manager, cfg, undefined, undefined, storage);

    const deleteRes = await app.inject({
        method: 'DELETE',
        url: '/v1/addons/addon:deletetest',
        headers: { 'Content-Type': 'application/json' },
        payload: { reason: 'Decommissioning obsolete stream source' }
    });

    assert.equal(deleteRes.statusCode, 200);
    const body = deleteRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.removed, 'addon:deletetest');
    assert.equal(body.reason, 'Decommissioning obsolete stream source');
    assert.equal(manager.get('addon:deletetest'), undefined);

    await cleanup();
});
