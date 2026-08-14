import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-jobs-engine.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('JobEngine enqueues and executes job successfully', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 2,
        pollIntervalMs: 50
    });

    let executed = false;
    let receivedPayload = null;

    engine.registerHandler('test-job', async (ctx) => {
        executed = true;
        receivedPayload = ctx.job.payload;
        await ctx.updateProgress(50);
        return { success: true, count: 42 };
    });

    engine.start();

    const job = await engine.enqueue('test-job', { foo: 'bar' });
    assert.equal(job.status, 'queued');

    // Wait for worker execution
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(executed, true);
    assert.deepEqual(receivedPayload, { foo: 'bar' });

    const finished = await storage.getJob(job.id);
    assert.equal(finished?.status, 'completed');
    assert.equal(finished?.progress, 100);
    assert.deepEqual(finished?.result, { success: true, count: 42 });

    engine.stop();
    await cleanup();
});

test('JobEngine enforces deduplication and idempotency keys', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg);
    engine.registerHandler('job-type', async () => ({}));

    // Idempotency: same key returns same job record
    const job1 = await engine.enqueue('job-type', {}, { idempotencyKey: 'idem-1' });
    const job2 = await engine.enqueue('job-type', {}, { idempotencyKey: 'idem-1' });
    assert.equal(job1.id, job2.id);

    // Dedup: active job with same dedupKey returns active job
    const job3 = await engine.enqueue('job-type', {}, { dedupKey: 'dedup-1' });
    const job4 = await engine.enqueue('job-type', {}, { dedupKey: 'dedup-1' });
    assert.equal(job3.id, job4.id);

    await cleanup();
});

test('JobEngine handles retries and dead_letter state', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 50
    });

    let attempts = 0;
    engine.registerHandler('failing-job', async () => {
        attempts++;
        throw new Error('Failure number ' + attempts);
    });

    engine.start();

    const job = await engine.enqueue('failing-job', {}, { maxAttempts: 2 });

    // Wait for retries
    await new Promise((r) => setTimeout(r, 400));

    const finalJob = await storage.getJob(job.id);
    assert.equal(finalJob?.status, 'dead_letter');
    assert.ok(finalJob?.error?.includes('Failure number'));

    engine.stop();
    await cleanup();
});

test('JobEngine supports active job cancellation', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 50
    });

    let aborted = false;
    engine.registerHandler('long-job', async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
            aborted = true;
        });
        await new Promise((r) => setTimeout(r, 500));
        return 'done';
    });

    engine.start();

    const job = await engine.enqueue('long-job', {});

    // Wait until started
    await new Promise((r) => setTimeout(r, 80));

    // Cancel job
    const cancelled = await engine.cancel(job.id);
    assert.equal(cancelled, true);

    await new Promise((r) => setTimeout(r, 100));

    assert.equal(aborted, true);
    const checked = await storage.getJob(job.id);
    assert.equal(checked?.status, 'cancelled');

    engine.stop();
    await cleanup();
});
