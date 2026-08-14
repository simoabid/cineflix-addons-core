import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fastify from 'fastify';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { registerJobRoutes } from '../dist/routes/jobs.routes.js';
import { loadConfig } from '../dist/config.js';

const testStoreFile = path.resolve('./data/test-jobs-routes.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('job REST API endpoints handle enqueue, inspection, and cancellation', async () => {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg);
    const app = fastify();

    registerJobRoutes(app, engine, storage, cfg);

    // 1. Enqueue job
    const resEnqueue = await app.inject({
        method: 'POST',
        url: '/v1/jobs',
        payload: {
            type: 'manifest-refresh',
            payload: { providerId: 'addon:test' },
            priority: 5
        }
    });

    assert.equal(resEnqueue.statusCode, 202);
    const bodyEnqueue = JSON.parse(resEnqueue.body);
    assert.equal(bodyEnqueue.ok, true);
    assert.ok(bodyEnqueue.job?.id);
    const jobId = bodyEnqueue.job.id;

    // 2. Inspect job
    const resGet = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobId}`
    });
    assert.equal(resGet.statusCode, 200);
    const bodyGet = JSON.parse(resGet.body);
    assert.equal(bodyGet.job.id, jobId);
    assert.equal(bodyGet.job.type, 'manifest-refresh');

    // 3. List jobs
    const resList = await app.inject({
        method: 'GET',
        url: '/v1/jobs?type=manifest-refresh'
    });
    assert.equal(resList.statusCode, 200);
    const bodyList = JSON.parse(resList.body);
    assert.ok(bodyList.jobs.length >= 1);

    // 4. Cancel job
    const resCancel = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/cancel`
    });
    assert.equal(resCancel.statusCode, 200);
    const bodyCancel = JSON.parse(resCancel.body);
    assert.equal(bodyCancel.ok, true);
    assert.equal(bodyCancel.job.status, 'cancelled');

    // 5. Retry job
    const resRetry = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/retry`
    });
    assert.equal(resRetry.statusCode, 200);
    const bodyRetry = JSON.parse(resRetry.body);
    assert.equal(bodyRetry.ok, true);
    assert.equal(bodyRetry.job.status, 'queued');

    await app.close();
    await cleanup();
});
