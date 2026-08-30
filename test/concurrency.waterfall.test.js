/**
 * Waterfall concurrency regression test.
 *
 * Guards against the provider-subtitle deadlock (found by the Phase 9 perf
 * harness): getStreams holds the per-provider reliability semaphore for the
 * whole request while collectSubtitles re-acquired the same non-reentrant
 * semaphore — every concurrent request deadlocked once the provider limit
 * was reached, unwedging only on unrelated upstream timeouts (~20s).
 *
 * Contract: N parallel progressive requests (N > provider concurrency limit)
 * against a subtitle-capable fake addon must all complete quickly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { scratchFile, startFakeAddonServer } from './helpers/harness.js';
import { startServer } from './e2e/helpers/server.js';
import {
    startFakeTmdb,
    startFakeMedia,
    mediaPayload
} from './e2e/helpers/fakes.js';

const PROVIDER_ID = 'addon:org-fake-addon';
const PARALLEL = 8; // provider-stream pool defaults to 4 — force queueing

test('parallel waterfall requests do not deadlock on the subtitle path', async () => {
    const tmdb = await startFakeTmdb();
    const media = await startFakeMedia(mediaPayload(1024));
    const addon = await startFakeAddonServer({
        // Subtitle-capable manifest is required to reach the old deadlock.
        streamsFor: () => [
            { url: `${media.baseUrl}/video.mp4`, title: 'Concurrency 1080p' }
        ]
    });

    const dataFile = scratchFile('concurrency-waterfall');
    await fs.rm(dataFile, { force: true });
    const server = await startServer({
        dataFile,
        env: {
            adminToken: 'conc-admin-token-0123456789abcdef',
            tmdbBaseUrl: `${tmdb.baseUrl}/3`,
            extra: { ADDONS_SEED_URLS: addon.manifestUrl }
        }
    });

    try {
        const url =
            `${server.baseUrl}/v1/movies/27205/providers/` +
            encodeURIComponent(PROVIDER_ID);

        // Warm the identity + provider caches so the measured window is pure
        // concurrency behavior, not first-boot import cost.
        const warm = await fetch(url);
        assert.equal(warm.status, 200);

        const t0 = Date.now();
        const statuses = await Promise.all(
            Array.from({ length: PARALLEL }, () =>
                fetch(url).then((r) => r.status)
            )
        );
        const wallMs = Date.now() - t0;

        assert.deepEqual(
            [...new Set(statuses)],
            [200],
            `all parallel requests must succeed (${statuses.join(',')})`
        );
        // A deadlock wedges until the 20s addon timeout unwinds it; a healthy
        // run against a loopback fake finishes in well under 5s.
        assert.ok(
            wallMs < 5_000,
            `parallel waterfall took ${wallMs}ms — concurrency deadlock regression`
        );
    } finally {
        // Stop the server AND every fake upstream — open handles would keep
        // this test file's process alive forever under `node --test`.
        await server.stop();
        await media.close();
        await tmdb.close();
        await addon.close();
    }
});
