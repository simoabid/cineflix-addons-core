import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ConcurrencyCoordinator,
    globalConcurrency
} from '../dist/concurrency/coordinator.js';
import { loadConfig } from '../dist/config.js';

function cfgWithConcurrency(overrides) {
    const cfg = loadConfig();
    return {
        ...cfg,
        concurrency: { ...cfg.concurrency, ...overrides }
    };
}

test('coordinator creates all Phase 7 pools from config', () => {
    const coord = new ConcurrencyCoordinator(
        cfgWithConcurrency({
            bulkScrape: 3,
            progressiveScrape: 5,
            providerStream: 2,
            subtitles: 7,
            manifest: 1,
            health: 9,
            debrid: 4,
            proxyStream: 11,
            hlsSegment: 13
        })
    );
    assert.equal(coord.pool('bulk-scrape').limit, 3);
    assert.equal(coord.pool('progressive-scrape').limit, 5);
    assert.equal(coord.pool('provider-stream').limit, 2);
    assert.equal(coord.pool('subtitles').limit, 7);
    assert.equal(coord.pool('manifest').limit, 1);
    assert.equal(coord.pool('health').limit, 9);
    assert.equal(coord.pool('debrid').limit, 4);
    assert.equal(coord.pool('proxy-stream').limit, 11);
    assert.equal(coord.pool('hls-segment').limit, 13);
    assert.ok(coord.isConfigured);
});

test('unconfigured coordinator falls back to safe defaults', () => {
    const coord = new ConcurrencyCoordinator();
    assert.equal(coord.isConfigured, false);
    assert.equal(coord.pool('bulk-scrape').limit, 8);
    assert.equal(coord.pool('health').limit, 4);
});

test('hostPool bounds per-host concurrency and isolates hosts', async () => {
    const coord = new ConcurrencyCoordinator(
        cfgWithConcurrency({ outboundHost: 1 })
    );
    const a1 = coord.hostPool('api.one.example');
    const a2 = coord.hostPool('api.two.example');
    assert.notEqual(a1, a2, 'each host gets its own pool');
    // Hostnames are case-insensitive.
    assert.equal(coord.hostPool('API.ONE.EXAMPLE'), a1);

    const r1 = await a1.acquire();
    let secondAdmitted = false;
    const second = a1.acquire().then((r) => {
        secondAdmitted = true;
        return r;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(secondAdmitted, false, 'per-host cap of 1 enforced');
    // Other host unaffected.
    const rOther = await a2.acquire();
    rOther();
    r1();
    const r2 = await second;
    r2();
});

test('withHostSlot serializes concurrent tasks per host', async () => {
    const coord = new ConcurrencyCoordinator(
        cfgWithConcurrency({ outboundHost: 1 })
    );
    let concurrent = 0;
    let max = 0;
    const task = (host) =>
        coord.withHostSlot(host, async () => {
            concurrent++;
            max = Math.max(max, concurrent);
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
        });
    await Promise.all([
        task('h.example'),
        task('h.example'),
        task('h.example')
    ]);
    assert.equal(max, 1);
});

test('snapshot exposes pool telemetry', async () => {
    const coord = new ConcurrencyCoordinator(cfgWithConcurrency({}));
    const r = await coord.pool('bulk-scrape').acquire();
    const snap = coord.snapshot();
    assert.ok(snap['bulk-scrape']);
    assert.equal(snap['bulk-scrape'].inFlight, 1);
    assert.equal(typeof snap['bulk-scrape'].totalAdmitted, 'number');
    r();
    assert.equal(coord.snapshot()['bulk-scrape'].inFlight, 0);
});

test('configure() replaces pools and resets host pools', async () => {
    const coord = new ConcurrencyCoordinator(
        cfgWithConcurrency({ bulkScrape: 1 })
    );
    assert.equal(coord.pool('bulk-scrape').limit, 1);
    const oldHost = coord.hostPool('x.example');
    coord.configure(cfgWithConcurrency({ bulkScrape: 6, outboundHost: 2 }));
    assert.equal(coord.pool('bulk-scrape').limit, 6);
    const newHost = coord.hostPool('x.example');
    assert.notEqual(oldHost, newHost, 'host pools re-created with new limit');
    assert.equal(newHost.limit, 2);
});

test('global singleton is usable and configurable', async () => {
    globalConcurrency.configure(cfgWithConcurrency({}));
    const release = await globalConcurrency.withSlot(
        'health',
        async () => 'ok'
    );
    assert.equal(release, 'ok');
    const snap = globalConcurrency.snapshot();
    for (const pool of [
        'bulk-scrape',
        'progressive-scrape',
        'provider-stream',
        'subtitles',
        'manifest',
        'health',
        'debrid',
        'proxy-stream',
        'hls-segment'
    ]) {
        assert.ok(snap[pool], `pool ${pool} present`);
    }
});
