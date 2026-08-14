import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { OptimisticLockError } from '../dist/storage/types.js';

const testFile = path.resolve('./data/test-opt-lock.json');

async function cleanup() {
    try {
        await fs.unlink(testFile);
    } catch {
        /* ignore */
    }
}

test('FileStorageBackend saves addon and increments version', async () => {
    await cleanup();
    const backend = new FileStorageBackend(testFile);
    await backend.init();

    const addon = {
        providerId: 'addon:test',
        slug: 'test',
        name: 'Test Addon',
        manifestUrl: 'https://test.com/manifest.json',
        baseUrl: 'https://test.com',
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'test', name: 'Test', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
        version: 1,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    const saved = await backend.saveAddon(addon);
    assert.equal(saved.version, 1);

    const saved2 = await backend.saveAddon(saved);
    assert.equal(saved2.version, 2);

    await cleanup();
});

test('FileStorageBackend throws OptimisticLockError on version conflict', async () => {
    await cleanup();
    const backend = new FileStorageBackend(testFile);
    await backend.init();

    const addon = {
        providerId: 'addon:conflict',
        slug: 'conflict',
        name: 'Conflict Addon',
        manifestUrl: 'https://conflict.com/manifest.json',
        baseUrl: 'https://conflict.com',
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'conflict', name: 'Conflict', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
        version: 1,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    const saved = await backend.saveAddon(addon);
    assert.equal(saved.version, 1);

    // Concurrent edit simulation: expected version 1 succeeds and moves version to 2
    await backend.saveAddon({ ...saved, name: 'Edit 1' }, 1);

    // Second concurrent edit attempts to update with stale version 1 -> throws OptimisticLockError
    await assert.rejects(
        async () => {
            await backend.saveAddon({ ...saved, name: 'Edit 2' }, 1);
        },
        (err) => err instanceof OptimisticLockError
    );

    await cleanup();
});

test('FileStorageBackend emits transactional outbox items', async () => {
    await cleanup();
    const backend = new FileStorageBackend(testFile);
    await backend.init();

    const addon = {
        providerId: 'addon:outbox-test',
        slug: 'outbox-test',
        name: 'Outbox Addon',
        manifestUrl: 'https://outbox.com/manifest.json',
        baseUrl: 'https://outbox.com',
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'outbox-test', name: 'Outbox', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
        version: 1,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    await backend.saveAddon(addon, undefined, {
        type: 'manifest-refresh',
        payload: { providerId: 'addon:outbox-test' }
    });

    const outbox = await backend.drainOutbox(10);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].jobType, 'manifest-refresh');
    assert.equal(outbox[0].payload.providerId, 'addon:outbox-test');

    await backend.markOutboxProcessed(outbox[0].id);
    const emptyOutbox = await backend.drainOutbox(10);
    assert.equal(emptyOutbox.length, 0);

    await cleanup();
});
