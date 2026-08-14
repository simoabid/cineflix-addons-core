import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { AddonManager } from '../dist/addons/manager.js';
import { HealthMonitor } from '../dist/health/monitor.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-jobs-integration.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('integration: HealthMonitor delegates sweeps to JobEngine', async () => {
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

    const manager = new AddonManager(fakeRegistry, {}, cfg);

    const engine = new JobEngine(storage, manager, cfg, {
        concurrency: 2,
        pollIntervalMs: 50
    });

    const monitor = new HealthMonitor(manager, {
        intervalMinutes: 15,
        autoRefresh: false,
        jobEngine: engine
    });

    engine.start();

    // Trigger sweep via monitor
    await monitor.triggerSweep();

    // Verify job was enqueued in storage
    const jobs = await storage.listJobs({ type: 'health-sweep' });
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].type, 'health-sweep');

    // Wait for execution to finish
    await new Promise((r) => setTimeout(r, 200));

    const finished = await storage.getJob(jobs[0].id);
    assert.equal(finished?.status, 'completed');

    engine.stop();
    await cleanup();
});

test('integration: maintenance-cleanup job removes expired grants and old jobs', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    // Seed expired grant
    await storage.saveGrant({
        id: 'expired-1',
        url: 'https://test.com/stream',
        headersJson: '{}',
        expiresAt: Math.floor(Date.now() / 1000) - 100, // expired
        createdAt: Math.floor(Date.now() / 1000) - 200,
        maxRedirects: 3,
        singleUse: false,
        used: false
    });

    // Seed active grant
    await storage.saveGrant({
        id: 'active-1',
        url: 'https://test.com/stream2',
        headersJson: '{}',
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // active
        createdAt: Math.floor(Date.now() / 1000),
        maxRedirects: 3,
        singleUse: false,
        used: false
    });

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 50
    });

    engine.start();

    const job = await engine.enqueue('maintenance-cleanup', {});

    await new Promise((r) => setTimeout(r, 200));

    const finished = await storage.getJob(job.id);
    assert.equal(finished?.status, 'completed');

    // Expired grant should be removed
    const g1 = await storage.getGrant('expired-1');
    assert.equal(g1, null);

    // Active grant should still exist
    const g2 = await storage.getGrant('active-1');
    assert.ok(g2);

    engine.stop();
    await cleanup();
});
