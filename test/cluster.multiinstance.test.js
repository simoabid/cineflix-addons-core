import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { ClusterBus } from '../dist/cluster/bus.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-cluster-sync.json');

async function cleanup() {
    try {
        await fs.unlink(testStoreFile);
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

function testAddonRecord(providerId, order = 0) {
    const now = new Date().toISOString();
    return {
        providerId,
        slug: providerId.replace('addon:', ''),
        name: providerId,
        manifestUrl: 'https://test.example/manifest.json',
        baseUrl: 'https://test.example',
        enabled: true,
        order,
        timeoutMs: 5000,
        source: 'manual',
        manifest: {
            id: providerId.replace('addon:', ''),
            name: providerId,
            version: '1.0',
            resources: ['stream'],
            types: ['movie', 'series'],
            catalogs: []
        },
        capabilities: undefined, // backfilled by manager on load
        addedAt: now,
        updatedAt: now,
        version: 1
    };
}

test('replica reloads configuration when another instance bumps the revision', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    // Instance A and B share storage but keep separate in-memory state.
    const registryA = createMockRegistry();
    const registryB = createMockRegistry();
    const managerA = AddonManager.create(registryA, cfg, storage);
    const managerB = AddonManager.create(registryB, cfg, storage);
    await managerA.init();
    await managerB.init();
    assert.equal(managerA.getRevision(), 0);
    assert.equal(managerB.getRevision(), 0);

    // Instance A installs an addon → shared revision bumps.
    await storage.saveAddon(testAddonRecord('addon:remote', 0));
    await storage.bumpRevision('install', 'instance-a');
    const revA = await storage.getRevision();
    assert.ok(revA > 0);

    // B has not observed the change yet.
    assert.equal(managerB.getRevision(), 0);
    assert.equal(managerB.get('addon:remote'), undefined);

    // The cluster-revision event arrives → B reloads from shared storage.
    const reloaded = await managerB.reloadFromStorage(
        `cluster-revision-${revA}`
    );
    assert.equal(reloaded, true);
    assert.equal(managerB.getRevision(), revA);
    assert.ok(managerB.get('addon:remote'), 'addon is visible on replica B');
    assert.equal(managerB.getStreamEnabled().length, 1);
    assert.equal(registryB.hasProvider('addon:remote'), true);

    // Reloading again (stale event) is a no-op.
    const again = await managerB.reloadFromStorage('stale-event');
    assert.equal(again, false);
    await storage.close();
});

test('replica sees disable/remove mutations after reload', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const managerA = AddonManager.create(createMockRegistry(), cfg, storage);
    const managerB = AddonManager.create(createMockRegistry(), cfg, storage);
    await managerA.init();
    await managerB.init();

    await storage.saveAddon(testAddonRecord('addon:gone', 0));
    await storage.bumpRevision('install', 'a');
    await managerB.reloadFromStorage('rev1');
    assert.ok(managerB.get('addon:gone'));

    // A removes it.
    await storage.removeAddon('addon:gone');
    await storage.bumpRevision('remove', 'a');
    await managerB.reloadFromStorage('rev2');
    assert.equal(managerB.get('addon:gone'), undefined);
    assert.equal(managerB.getStreamEnabled().length, 0);
    await storage.close();
});

test('ClusterBus without Redis stays in disabled mode and publishes are no-ops', async () => {
    const bus = new ClusterBus({
        enabled: true,
        instanceId: 'inst_test',
        redis: undefined
    });
    const mode = await bus.start();
    assert.equal(mode, 'disabled');
    assert.equal(bus.mode, 'disabled');
    // Publishing must not throw even without a connection.
    await bus.publish({ type: 'revision', revision: 5, origin: 'inst_test' });
    const stats = bus.stats();
    assert.equal(stats.instanceId, 'inst_test');
    assert.equal(stats.published, 0, 'nothing actually sent in disabled mode');
    await bus.close();
    await bus.close(); // idempotent
});

test('ClusterBus disabled when feature flag is off', async () => {
    const bus = new ClusterBus({
        enabled: false,
        instanceId: 'inst_test',
        redis: { host: 'localhost', port: 6379 }
    });
    assert.equal(await bus.start(), 'disabled');
    await bus.close();
});
