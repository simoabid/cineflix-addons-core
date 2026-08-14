import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAddonRoutes } from '../dist/routes/addons.routes.js';
import { loadConfig } from '../dist/config.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const testStoreFile = path.resolve('./data/test-debrid-limits.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('Transfer route enforces global and per-user transfer limits', async () => {
    await cleanup();
    const cfg = {
        ...loadConfig(),
        debridMaxUserTransfers: 2,
        debridMaxGlobalTransfers: 3,
        authMode: 'disabled',
        trustedProxyCidrs: ['127.0.0.1/32']
    };

    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const mockJobEngine = {
        enqueue: async (type, payload, opts) => {
            return storage.enqueueJob({
                type,
                payload,
                dedupKey: opts?.dedupKey,
                requester: opts?.requester
            });
        },
        cancel: async () => {}
    };

    const app = Fastify();
    registerAddonRoutes(
        app,
        { list: () => [], describeStore: () => ({ type: 'file' }), getRevision: () => 1 },
        cfg,
        {},
        null,
        storage,
        {},
        mockJobEngine
    );

    // 1. User 1 enqueues 2 jobs (allowed)
    const res1 = await app.inject({
        method: 'POST',
        url: '/v1/debrid/transfers',
        payload: { infoHash: '0123456789abcdef0123456789abcdef01234567' },
        headers: { 'x-forwarded-for': '1.1.1.1' }
    });
    assert.equal(res1.statusCode, 202);

    const res2 = await app.inject({
        method: 'POST',
        url: '/v1/debrid/transfers',
        payload: { infoHash: '1123456789abcdef0123456789abcdef01234567' },
        headers: { 'x-forwarded-for': '1.1.1.1' }
    });
    assert.equal(res2.statusCode, 202);

    // 2. User 1 tries to enqueue a 3rd job -> rejected by USER_TRANSFER_LIMIT_EXCEEDED
    const res3 = await app.inject({
        method: 'POST',
        url: '/v1/debrid/transfers',
        payload: { infoHash: '2123456789abcdef0123456789abcdef01234567' },
        headers: { 'x-forwarded-for': '1.1.1.1' }
    });
    assert.equal(res3.statusCode, 429);
    const body3 = JSON.parse(res3.payload);
    assert.equal(body3.error.code, 'USER_TRANSFER_LIMIT_EXCEEDED');

    // 3. User 2 enqueues a job (global count becomes 3) -> allowed
    const res4 = await app.inject({
        method: 'POST',
        url: '/v1/debrid/transfers',
        payload: { infoHash: '3123456789abcdef0123456789abcdef01234567' },
        headers: { 'x-forwarded-for': '2.2.2.2' }
    });
    assert.equal(res4.statusCode, 202);

    // 4. User 3 tries to enqueue -> rejected by GLOBAL_TRANSFER_LIMIT_EXCEEDED
    const res5 = await app.inject({
        method: 'POST',
        url: '/v1/debrid/transfers',
        payload: { infoHash: '4123456789abcdef0123456789abcdef01234567' },
        headers: { 'x-forwarded-for': '3.3.3.3' }
    });
    assert.equal(res5.statusCode, 429);
    const body5 = JSON.parse(res5.payload);
    assert.equal(body5.error.code, 'GLOBAL_TRANSFER_LIMIT_EXCEEDED');

    await app.close();
    await cleanup();
});
