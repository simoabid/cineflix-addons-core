import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';

const SET_VARS = [
    'CONCURRENCY_BULK_SCRAPE',
    'CONCURRENCY_PROGRESSIVE_SCRAPE',
    'CONCURRENCY_PROVIDER_STREAM',
    'CONCURRENCY_OUTBOUND_HOST',
    'CONCURRENCY_SUBTITLES',
    'CONCURRENCY_MANIFEST',
    'CONCURRENCY_HEALTH',
    'CONCURRENCY_DEBRID',
    'CONCURRENCY_PROXY_STREAM',
    'CONCURRENCY_HLS_SEGMENT',
    'CONCURRENCY_QUEUE_MAX',
    'CONCURRENCY_QUEUE_TIMEOUT_MS',
    'TERMINATION_GRACE_PERIOD_MS',
    'SHUTDOWN_DRAIN_JOBS',
    'CLUSTER_BUS_ENABLED',
    'MAX_CONCURRENT_STREAMS_PER_IP',
    'MAX_CONCURRENT_STREAMS_PER_USER',
    'MAX_CONCURRENT_STREAMS_GLOBAL',
    'BULK_MAX_PROVIDERS_PER_REQUEST',
    'SOURCE_LOOKUP_DEADLINE_MS',
    'PLAYBACK_GRANT_MAX_ACTIVE',
    'PLAYBACK_GRANT_MAX_PER_REQUEST',
    'PROVIDER_DAILY_CALL_BUDGET',
    'PROVIDER_BUDGET_OVERRIDES',
    'EGRESS_DAILY_BUDGET_MB',
    'EGRESS_PROXY_DAILY_BUDGET_MB',
    'SCRAPE_RATE_LIMIT_PER_MIN',
    'ANON_SCRAPE_RATE_LIMIT_PER_MIN',
    'PROXY_RATE_LIMIT_PER_MIN',
    'QUARANTINE_ENABLED',
    'QUARANTINE_OPEN_THRESHOLD',
    'QUARANTINE_WINDOW_MS',
    'QUARANTINE_TTL_MS'
];

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('loadConfig exposes Phase 7 defaults', () => {
    withEnv(Object.fromEntries(SET_VARS.map((v) => [v, ''])), () => {
        const cfg = loadConfig();
        assert.equal(cfg.concurrency.bulkScrape, 8);
        assert.equal(cfg.concurrency.progressiveScrape, 16);
        assert.equal(cfg.concurrency.providerStream, 4);
        assert.equal(cfg.concurrency.outboundHost, 8);
        assert.equal(cfg.concurrency.subtitles, 8);
        assert.equal(cfg.concurrency.manifest, 6);
        assert.equal(cfg.concurrency.health, 4);
        assert.equal(cfg.concurrency.debrid, 6);
        assert.equal(cfg.concurrency.proxyStream, 32);
        assert.equal(cfg.concurrency.hlsSegment, 64);
        assert.equal(cfg.concurrency.queueMax, 200);
        assert.equal(cfg.concurrency.queueTimeoutMs, 5000);
        assert.equal(cfg.terminationGracePeriodMs, 15000);
        assert.equal(cfg.shutdownDrainJobs, true);
        assert.equal(cfg.clusterBusEnabled, true);
        assert.equal(cfg.maxConcurrentStreamsPerIp, 3);
        assert.equal(cfg.maxConcurrentStreamsPerUser, 4);
        assert.equal(cfg.maxConcurrentStreamsGlobal, 200);
        assert.equal(cfg.bulkMaxProvidersPerRequest, 16);
        assert.equal(cfg.sourceLookupDeadlineMs, 20000);
        assert.equal(cfg.playbackGrantMaxActive, 50000);
        assert.equal(cfg.playbackGrantMaxPerRequest, 500);
        assert.equal(cfg.providerDailyCallBudget, 0);
        assert.deepEqual(cfg.providerBudgetOverrides, {});
        assert.equal(cfg.egressDailyBudgetMb, 0);
        assert.equal(cfg.egressProxyDailyBudgetMb, 0);
        assert.equal(cfg.scrapeRateLimitPerMin, 30);
        assert.equal(cfg.anonScrapeRateLimitPerMin, 30);
        assert.equal(cfg.proxyRateLimitPerMin, 120);
        assert.equal(cfg.quarantineEnabled, true);
        assert.equal(cfg.quarantineOpenThreshold, 5);
        assert.equal(cfg.quarantineWindowMs, 3600000);
        assert.equal(cfg.quarantineTtlMs, 21600000);
    });
});

test('loadConfig reads Phase 7 overrides', () => {
    withEnv(
        {
            CONCURRENCY_BULK_SCRAPE: '2',
            CONCURRENCY_PROXY_STREAM: '7',
            TERMINATION_GRACE_PERIOD_MS: '30000',
            SHUTDOWN_DRAIN_JOBS: 'false',
            MAX_CONCURRENT_STREAMS_PER_IP: '1',
            BULK_MAX_PROVIDERS_PER_REQUEST: '4',
            PROVIDER_DAILY_CALL_BUDGET: '1000',
            PROVIDER_BUDGET_OVERRIDES:
                '{"addon:fragile":25,"addon:ignored":"x"}',
            EGRESS_DAILY_BUDGET_MB: '512',
            ANON_SCRAPE_RATE_LIMIT_PER_MIN: '5',
            QUARANTINE_OPEN_THRESHOLD: '2',
            QUARANTINE_TTL_MS: '0'
        },
        () => {
            const cfg = loadConfig();
            assert.equal(cfg.concurrency.bulkScrape, 2);
            assert.equal(cfg.concurrency.proxyStream, 7);
            assert.equal(cfg.terminationGracePeriodMs, 30000);
            assert.equal(cfg.shutdownDrainJobs, false);
            assert.equal(cfg.maxConcurrentStreamsPerIp, 1);
            assert.equal(cfg.bulkMaxProvidersPerRequest, 4);
            assert.equal(cfg.providerDailyCallBudget, 1000);
            assert.deepEqual(cfg.providerBudgetOverrides, {
                'addon:fragile': 25
            });
            assert.equal(cfg.egressDailyBudgetMb, 512);
            assert.equal(cfg.anonScrapeRateLimitPerMin, 5);
            assert.equal(cfg.quarantineOpenThreshold, 2);
            assert.equal(cfg.quarantineTtlMs, 0);
        }
    );
});

test('malformed PROVIDER_BUDGET_OVERRIDES falls back to empty', () => {
    withEnv({ PROVIDER_BUDGET_OVERRIDES: 'not-json{{' }, () => {
        assert.deepEqual(loadConfig().providerBudgetOverrides, {});
    });
    withEnv({ PROVIDER_BUDGET_OVERRIDES: '[1,2,3]' }, () => {
        assert.deepEqual(loadConfig().providerBudgetOverrides, {});
    });
});
