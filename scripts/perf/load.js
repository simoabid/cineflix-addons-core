/**
 * Performance / load harness (Phase 9 §12.1).
 *
 * Dependency-free alternative to k6/Artillery: boots the compiled server
 * (dist/server.js) against local fake upstreams — the same hermetic setup as
 * the e2e suite — then drives closed-loop HTTP load and reports latency
 * percentiles per scenario.
 *
 * Scenarios:
 *   aggregate   — OMSS aggregate GET /v1/movies/:id (framework fan-out, cached)
 *   waterfall   — progressive single-provider scrape (CINEFLIX request path)
 *   cache       — cache effectiveness: repeated ids vs rotating ids
 *   range       — proxy streaming with HTTP Range requests (playback grants)
 *   all         — run every scenario in sequence (default)
 *
 * Usage:
 *   npm run build && node scripts/perf/load.js [--scenario X] \
 *     [--concurrency 8] [--duration 10] [--warmup 2]
 */
import { parseArgs } from 'node:util';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
);

// Dev-only helpers (test/ is not part of the shipped artifact).
const { startFakeAddonServer, scratchFile } = await import(
    path.join(ROOT, 'test/helpers/harness.js')
);
const { startServer } = await import(
    path.join(ROOT, 'test/e2e/helpers/server.js')
);
const { startFakeTmdb, startFakeMedia, mediaPayload } = await import(
    path.join(ROOT, 'test/e2e/helpers/fakes.js')
);

const { values } = parseArgs({
    options: {
        scenario: { type: 'string', default: 'all' },
        concurrency: { type: 'string', default: '8' },
        duration: { type: 'string', default: '10' },
        warmup: { type: 'string', default: '2' }
    }
});

const CONCURRENCY = Math.max(1, Number(values.concurrency));
const DURATION_SEC = Math.max(1, Number(values.duration));
const WARMUP_SEC = Math.max(0, Number(values.warmup));

// ── Latency stats ────────────────────────────────────────────────────────────

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(
        sorted.length - 1,
        Math.ceil((p / 100) * sorted.length) - 1
    );
    return sorted[Math.max(0, idx)];
}

function reportLatencies(label, latencies, wallMs) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const rps = (sorted.length / wallMs) * 1000;
    console.log(
        [
            `  ${label.padEnd(24)}`,
            `n=${String(sorted.length).padStart(6)}`,
            `rps=${rps.toFixed(0).padStart(6)}`,
            `p50=${percentile(sorted, 50).toFixed(0).padStart(6)}ms`,
            `p95=${percentile(sorted, 95).toFixed(0).padStart(6)}ms`,
            `p99=${percentile(sorted, 99).toFixed(0).padStart(6)}ms`,
            `max=${percentile(sorted, 100).toFixed(0).padStart(6)}ms`
        ].join('  ')
    );
    return { rps };
}

// ── Load driver ──────────────────────────────────────────────────────────────

/**
 * Run `worker` under a closed-loop concurrency model for a wall-clock
 * duration. Each worker loops request → record → repeat without waiting for
 * peers. Returns per-request latencies (ms) and failure count.
 */
async function runLoad(durationSec, workers, worker) {
    const latencies = [];
    let failures = 0;
    const deadline = Date.now() + durationSec * 1000;

    const loops = Array.from({ length: workers }, async () => {
        while (Date.now() < deadline) {
            const t0 = performance.now();
            try {
                await worker();
            } catch {
                failures++;
            }
            latencies.push(performance.now() - t0);
        }
    });
    const wallStart = Date.now();
    await Promise.all(loops);
    const wallMs = Date.now() - wallStart;
    return { latencies, failures, wallMs };
}

// ── Scenario setup ───────────────────────────────────────────────────────────

const MEDIA_BYTES = mediaPayload(1024 * 1024); // 1 MiB
const PROVIDER_ID = 'addon:org-fake-addon';

async function boot() {
    const tmdb = await startFakeTmdb();
    const media = await startFakeMedia(MEDIA_BYTES);
    const addon = await startFakeAddonServer({
        streamsFor: () => [
            {
                url: `${media.baseUrl}/video.mp4`,
                title: 'Perf Stream 1080p',
                quality: '1080p'
            }
        ]
    });
    const dataFile = scratchFile('perf-load');
    // Scratch files persist across runs; a stale file would point addons at
    // dead upstream ports from a previous session. Start clean every time.
    await rm(dataFile, { force: true });
    const server = await startServer({
        dataFile,
        env: {
            adminToken: 'perf-admin-token-0123456789abcdef',
            tmdbBaseUrl: `${tmdb.baseUrl}/3`,
            extra: { ADDONS_SEED_URLS: addon.manifestUrl }
        }
    });
    // Wait until the seeded addon is installed and advertised as a provider.
    for (let i = 0; i < 100; i++) {
        try {
            const res = await fetch(`${server.baseUrl}/v1/providers`);
            const body = await res.json();
            if (Array.isArray(body) && body.some((p) => p.id === PROVIDER_ID))
                break;
        } catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return { server, cleanup: () => server.stop() };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioAggregate(server, label) {
    console.log(`\n▸ ${label}: OMSS aggregate GET /v1/movies/:id`);
    await runLoad(WARMUP_SEC, CONCURRENCY, async () => {
        const res = await fetch(`${server.baseUrl}/v1/movies/27205`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
    });
    const { latencies, failures, wallMs } = await runLoad(
        DURATION_SEC,
        CONCURRENCY,
        async () => {
            const res = await fetch(`${server.baseUrl}/v1/movies/27205`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.arrayBuffer();
        }
    );
    reportLatencies(label, latencies, wallMs);
    return { failures };
}

async function scenarioWaterfall(server, label) {
    console.log(
        `\n▸ ${label}: progressive waterfall /v1/movies/:id/providers/:pid`
    );
    const url =
        `${server.baseUrl}/v1/movies/27205/providers/` +
        encodeURIComponent(PROVIDER_ID);
    const { latencies, failures, wallMs } = await runLoad(
        DURATION_SEC,
        CONCURRENCY,
        async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.arrayBuffer();
        }
    );
    reportLatencies(label, latencies, wallMs);
    return { failures };
}

async function scenarioCache(server, label) {
    console.log(`\n▸ ${label}: cache effectiveness (repeat vs rotate ids)`);
    const repeat = await runLoad(DURATION_SEC, CONCURRENCY, async () => {
        const res = await fetch(`${server.baseUrl}/v1/movies/27205`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
    });
    reportLatencies(`${label} [repeat]`, repeat.latencies, repeat.wallMs);

    let counter = 0;
    const rotate = await runLoad(DURATION_SEC, CONCURRENCY, async () => {
        const id = 100000 + (counter++ % 500);
        const res = await fetch(`${server.baseUrl}/v1/movies/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
    });
    reportLatencies(`${label} [rotate]`, rotate.latencies, rotate.wallMs);
    return { failures: repeat.failures + rotate.failures };
}

async function scenarioRange(server, label) {
    console.log(`\n▸ ${label}: proxy streaming with Range requests`);
    // Mint one playback grant for the media origin, then hammer it.
    const streamUrl =
        `${server.baseUrl}/v1/movies/27205/providers/` +
        encodeURIComponent(PROVIDER_ID);
    const probe = await fetch(streamUrl);
    const body = await probe.json();
    const grantUrl = body?.sources?.[0]?.url;
    if (!grantUrl) {
        console.log('  skipped — no playback grant URL available');
        return { failures: 0 };
    }
    const absolute = new URL(grantUrl, server.baseUrl).toString();
    const { latencies, failures, wallMs } = await runLoad(
        DURATION_SEC,
        Math.min(CONCURRENCY, 16),
        async () => {
            const res = await fetch(absolute, {
                headers: { range: 'bytes=0-65535' }
            });
            if (!res.ok && res.status !== 206)
                throw new Error(`HTTP ${res.status}`);
            await res.arrayBuffer();
        }
    );
    reportLatencies(label, latencies, wallMs);
    return { failures };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(
        `addons-core load harness — concurrency=${CONCURRENCY} ` +
            `duration=${DURATION_SEC}s warmup=${WARMUP_SEC}s`
    );
    const { server, cleanup } = await boot();
    const wanted =
        values.scenario === 'all'
            ? ['aggregate', 'waterfall', 'cache', 'range']
            : [values.scenario];
    let totalFailures = 0;
    try {
        if (wanted.includes('aggregate'))
            totalFailures += (await scenarioAggregate(server, 'aggregate'))
                .failures;
        if (wanted.includes('waterfall'))
            totalFailures += (await scenarioWaterfall(server, 'waterfall'))
                .failures;
        if (wanted.includes('cache'))
            totalFailures += (await scenarioCache(server, 'cache')).failures;
        if (wanted.includes('range'))
            totalFailures += (await scenarioRange(server, 'range')).failures;
    } finally {
        await cleanup();
    }
    if (totalFailures > 0)
        console.warn(`\n⚠ ${totalFailures} failed requests during run`);
    console.log('\nDone.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
