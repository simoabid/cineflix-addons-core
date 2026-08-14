import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fastify from 'fastify';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { registerJobRoutes } from '../dist/routes/jobs.routes.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-jobs-validation.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('JobEngine and REST API reject unknown job types', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg);
    const app = fastify();
    registerJobRoutes(app, engine, storage, cfg);

    // 1. Enqueue unknown job type via REST API -> Expect 400 Bad Request
    const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        payload: {
            type: 'non-existent-random-job-type',
            payload: {}
        }
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error?.code, 'UNKNOWN_JOB_TYPE');
    assert.ok(body.error?.message?.includes('non-existent-random-job-type'));

    // 2. Enqueue unknown job type directly via engine -> Expect thrown Error
    await assert.rejects(
        async () => {
            await engine.enqueue('non-existent-random-job-type', {});
        },
        /Cannot enqueue job with unregistered type/
    );

    await app.close();
    await cleanup();
});

test('JobEngine schedules recurring maintenance cleanup', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 50
    });

    engine.start();

    // The maintenance timer is set on start()
    // Wait a brief moment and verify engine has registered maintenance-cleanup
    assert.equal(engine.hasHandler('maintenance-cleanup'), true);
    assert.ok(engine.getRegisteredTypes().includes('maintenance-cleanup'));

    engine.stop();
    await cleanup();
});
