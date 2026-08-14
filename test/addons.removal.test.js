import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { BackendAddonStore } from '../dist/addons/store.js';
import { AddonManager } from '../dist/addons/manager.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-addon-removals.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('BackendAddonStore reconciles and removes deleted addons in storage', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const store = new BackendAddonStore(storage);

    // Initial save of 2 addons
    await store.save({
        version: 1,
        revision: 1,
        addons: [
            {
                providerId: 'addon:keep',
                slug: 'keep',
                name: 'Keep Addon',
                manifestUrl: 'https://keep.com/manifest.json',
                baseUrl: 'https://keep.com',
                enabled: true,
                order: 0,
                timeoutMs: 5000,
                source: 'manual',
                manifest: { id: 'keep', name: 'Keep', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
                addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                providerId: 'addon:remove-me',
                slug: 'remove-me',
                name: 'Remove Me Addon',
                manifestUrl: 'https://remove.com/manifest.json',
                baseUrl: 'https://remove.com',
                enabled: true,
                order: 1,
                timeoutMs: 5000,
                source: 'manual',
                manifest: { id: 'remove', name: 'Remove', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
                addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ]
    });

    let stored = await storage.listAddons();
    assert.equal(stored.length, 2);

    // Save with 'addon:remove-me' omitted (simulating deletion)
    await store.save({
        version: 1,
        revision: 2,
        addons: [
            {
                providerId: 'addon:keep',
                slug: 'keep',
                name: 'Keep Addon',
                manifestUrl: 'https://keep.com/manifest.json',
                baseUrl: 'https://keep.com',
                enabled: true,
                order: 0,
                timeoutMs: 5000,
                source: 'manual',
                manifest: { id: 'keep', name: 'Keep', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
                addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ]
    });

    stored = await storage.listAddons();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].providerId, 'addon:keep');

    // Reload through store and verify removed addon is completely gone
    const loaded = await store.load();
    assert.equal(loaded.addons.length, 1);
    assert.equal(loaded.addons[0].providerId, 'addon:keep');

    await cleanup();
});

test('AddonManager removal persists across restarts with unified storage backend', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    // Pre-seed an addon directly in storage
    await storage.saveAddon({
        providerId: 'addon:persist-test',
        slug: 'persist-test',
        name: 'Persist Test Addon',
        manifestUrl: 'https://example.com/manifest.json',
        baseUrl: 'https://example.com',
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'persist-test', name: 'Persist Test', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
        version: 1,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    const fakeRegistry = {
        hasProvider: () => false,
        register: () => {},
        unregister: () => {},
        listProviders: () => [],
        getProviders: () => []
    };

    const manager = AddonManager.create(fakeRegistry, cfg, storage);
    await manager.init();

    assert.equal(manager.list().length, 1);
    assert.equal(manager.list()[0].providerId, 'addon:persist-test');

    // Remove addon via manager
    const removed = await manager.remove('addon:persist-test');
    assert.equal(removed, true);
    assert.equal(manager.list().length, 0);

    // Simulate server restart: create brand new manager instance with same storage
    const managerRestarted = AddonManager.create(fakeRegistry, cfg, storage);
    await managerRestarted.init();

    assert.equal(managerRestarted.list().length, 0);
    const inStorage = await storage.listAddons();
    assert.equal(inStorage.length, 0);

    await cleanup();
});
