import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { loadConfig } from '../dist/config.js';
import { uncachedTransferHandler } from '../dist/jobs/handlers/uncachedTransferHandler.js';
import { debridService } from '../dist/debrid/service.js';

const testStoreFile = path.resolve('./data/test-debrid-uncached.json');

async function cleanup() {
    try { await fs.unlink(testStoreFile); } catch { /* ignore */ }
}

test('Uncached transfer job handler validation and lifecycle', async () => {
    await cleanup();
    const cfg = loadConfig();
    const storage = new FileStorageBackend(testStoreFile);
    await storage.init();

    const engine = new JobEngine(storage, {}, cfg, {
        concurrency: 1,
        pollIntervalMs: 50
    });

    // 1. Verify JobEngine has registered uncached-transfer
    assert.equal(engine.hasHandler('uncached-transfer'), true);
    assert.ok(engine.getRegisteredTypes().includes('uncached-transfer'));

    // 2. Reject job with invalid infoHash
    const invalidJob = await engine.enqueue('uncached-transfer', {
        infoHash: 'invalid-infohash'
    });

    // Run worker once to process
    engine.start();

    // Poll until failed
    for (let i = 0; i < 20; i++) {
        const j = await storage.getJob(invalidJob.id);
        if (j && (j.status === 'failed' || j.status === 'dead_letter')) {
            assert.ok(j.error?.includes('Invalid or missing infoHash'));
            break;
        }
        await new Promise((r) => setTimeout(r, 50));
    }

    engine.stop();
    await cleanup();
});

test('uncachedTransferHandler polls transfer status without re-submitting and wraps grant URL', async () => {
    const cfg = loadConfig();
    let initialSubmitCount = 0;
    let pollCount = 0;

    const mockResolver = {
        id: 'realdebrid',
        name: 'Real-Debrid',
        getCapabilities: () => ({
            supportsInstantAvailabilityCheck: true,
            supportsFileSelection: true,
            supportsUncachedTransfers: true,
            supportsLinkExpiry: false
        }),
        checkCredentials: async () => ({ ok: true, user: 'testuser' }),
        check: async () => ({ ok: true, user: 'testuser' }),
        resolveCached: async (input) => {
            initialSubmitCount++;
            return {
                kind: 'uncached',
                torrentId: 'test-torrent-123',
                progress: 25,
                status: 'downloading'
            };
        },
        pollTransferStatus: async (torrentId, opts) => {
            pollCount++;
            assert.equal(torrentId, 'test-torrent-123');
            if (pollCount === 1) {
                return {
                    kind: 'uncached',
                    torrentId,
                    progress: 75,
                    status: 'downloading'
                };
            }
            return {
                kind: 'resolved',
                url: 'https://download.real-debrid.com/d/RAW_TOKEN/video.mp4',
                selectedFile: {
                    index: 0,
                    name: 'video.mp4',
                    size: 1500000000,
                    matchReason: 'exact_season_episode_match',
                    confidence: 0.95
                },
                cached: false
            };
        },
        resolve: async () => null,
        cleanup: async () => {},
        classifyError: () => 'unknown'
    };

    debridService.configure({ provider: 'realdebrid', apiKey: 'test-key' });
    debridService['resolver'] = mockResolver;

    const mockJobContext = {
        job: {
            id: 'job-123',
            type: 'uncached-transfer',
            payload: {
                infoHash: '0123456789abcdef0123456789abcdef01234567',
                maxWaitSec: 10
            }
        },
        cfg,
        updateProgress: async (p) => {},
        heartbeat: async () => {},
        signal: new AbortController().signal
    };

    const result = await uncachedTransferHandler(mockJobContext);

    // Initial submission called only ONCE
    assert.equal(initialSubmitCount, 1);
    // Polling called dedicated pollTransferStatus
    assert.ok(pollCount >= 2);
    assert.equal(result.status, 'completed');
    // Result URL is wrapped in playback grant and never exposes raw resolver link
    assert.ok(typeof result.url === 'string');
    assert.ok(result.url.includes('/v1/proxy/grant/'));

    debridService.configure({ provider: 'none', apiKey: '' });
});
