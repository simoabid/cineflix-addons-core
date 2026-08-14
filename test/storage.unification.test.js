import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { AddonManager } from '../dist/addons/manager.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-storage-unification.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('storage backend is unified between manager mutations and job engine', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const fakeRegistry = {
        hasProvider: () => false,
        register: () => {},
        unregister: () => {},
        listProviders: () => [],
        getProviders: () => []
    };

    const manager = AddonManager.create(fakeRegistry, cfg, storage);
    await manager.init();

    const engine = new JobEngine(storage, manager, cfg, {
        concurrency: 1,
        pollIntervalMs: 50
    });

    // 1. Enqueue job
    const job = await engine.enqueue('manifest-refresh', { providerId: 'test' });
    assert.equal(job.status, 'queued');

    // 2. Perform manager mutation (e.g. debrid update)
    await manager.updateDebridSettings({
        provider: 'realdebrid',
        apiKey: 'test-api-key-123'
    });

    // 3. Verify job was NOT erased by manager save
    const jobAfterManagerSave = await storage.getJob(job.id);
    assert.ok(jobAfterManagerSave);
    assert.equal(jobAfterManagerSave.id, job.id);

    // 4. Save a playback grant in storage
    await storage.saveGrant({
        id: 'grant-unif-1',
        url: 'https://stream.example.com/video.mp4',
        headersJson: '{}',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: Math.floor(Date.now() / 1000),
        maxRedirects: 3,
        singleUse: false,
        used: false
    });

    // 5. Trigger another manager save
    await manager.updateDebridSettings({
        provider: 'alldebrid',
        apiKey: 'test-api-key-456'
    });

    // 6. Verify grant still exists in storage
    const grant = await storage.getGrant('grant-unif-1');
    assert.ok(grant);
    assert.equal(grant.id, 'grant-unif-1');

    // 7. Verify debrid settings match
    const debrid = await storage.getDebridConfig();
    assert.equal(debrid?.provider, 'alldebrid');

    await cleanup();
});
