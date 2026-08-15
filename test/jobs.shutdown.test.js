import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-jobs-shutdown.json');

async function cleanup() {
    try {
        await fs.unlink(testStoreFile);
    } catch {
        /* ignore */
    }
}

test('beginShutdown drains quick jobs to completion', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 2,
        pollIntervalMs: 20
    });
    let completed = 0;
    engine.registerHandler('quick-job', async () => {
        await new Promise((r) => setTimeout(r, 30));
        completed++;
        return { ok: true };
    });

    engine.start();
    const job = await engine.enqueue('quick-job', { n: 1 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(engine.activeJobCount >= 0, true);

    // Drain window comfortably covers the 30ms job.
    await engine.beginShutdown(500);
    assert.equal(completed, 1);
    const finished = await storage.getJob(job.id);
    assert.equal(finished.status, 'completed');

    const stats = engine.getStats();
    assert.equal(stats.running, false);
    assert.equal(stats.draining, false, 'draining flag cleared after drain');
    assert.equal(stats.activeJobs, 0);
    await storage.close();
});

test('beginShutdown releases straggler jobs for retry instead of cancelling', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 20
    });
    engine.registerHandler('stuck-job', async (ctx) => {
        // Ignores the abort signal — simulates a handler stuck on I/O.
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true };
    });

    engine.start();
    const job = await engine.enqueue('stuck-job', {});
    // Wait until the worker picks it up.
    let pickedUp = false;
    for (let i = 0; i < 50 && !pickedUp; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const j = await storage.getJob(job.id);
        pickedUp = j.status === 'running';
    }
    assert.equal(pickedUp, true, 'job must be running before drain');

    // Drain deadline shorter than the job's internal sleep.
    await engine.beginShutdown(120);

    const after = await storage.getJob(job.id);
    assert.notEqual(after.status, 'cancelled');
    assert.notEqual(after.status, 'completed');
    assert.equal(
        after.status,
        'queued',
        'released for retry by another worker'
    );
    assert.match(after.error, /worker shutdown/i);
    assert.equal(after.lockedBy, undefined, 'lease released');
    await storage.close();
});

test('beginShutdown is idempotent and stops polling for new work', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 10
    });
    let executed = 0;
    engine.registerHandler('post-drain-job', async () => {
        executed++;
        return {};
    });
    engine.start();
    await engine.beginShutdown(50);
    await engine.beginShutdown(50); // no-op

    // Enqueue directly to storage (engine no longer polls).
    await storage.enqueueJob({ type: 'post-drain-job', payload: {} });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(executed, 0, 'engine must not pick up work after drain');
    await storage.close();
});
