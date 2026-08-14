import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthMonitor } from '../dist/health/monitor.js';

test('health: getLiveness reports process loop uptime and pid', () => {
    const mockManager = {
        list: () => [],
        getStreamEnabled: () => [],
        getRevision: () => 1
    };
    const monitor = new HealthMonitor(mockManager, { intervalMinutes: 0, autoRefresh: false, version: '1.0.0' });

    const live = monitor.getLiveness();
    assert.equal(live.status, 'ok');
    assert.equal(live.pid, process.pid);
    assert.equal(live.version, '1.0.0');
    assert.ok(live.uptimeSec >= 0);
    assert.ok(typeof live.eventLoopLagMs === 'number');
    assert.ok(live.eventLoopLagMs >= 0);
});

test('health: getReadiness checks storage and cache health', async () => {
    const mockManager = {
        list: () => [],
        getStreamEnabled: () => [],
        getRevision: () => 1
    };
    const monitor = new HealthMonitor(mockManager, { intervalMinutes: 0, autoRefresh: false });

    const mockStorage = {
        readAddons: async () => ({ addons: [], revision: 1 }),
        isHealthy: async () => true
    };
    const mockCache = {
        snapshot: () => ({ size: 5, hits: 10, misses: 2 })
    };

    const report = await monitor.getReadiness({
        storage: mockStorage,
        cache: mockCache
    });

    assert.equal(report.ready, true);
    assert.equal(report.status, 'ok');
    assert.equal(report.checks.storage.ok, true);
    assert.equal(report.checks.cache.ok, true);
});

test('health: getServiceStatus marks degraded when usable provider ratio is below threshold', async () => {
    const freshTimestamp = new Date().toISOString();
    const mockAddons = [
        {
            providerId: 'addon-1',
            name: 'Addon 1',
            enabled: true,
            capabilities: ['stream'],
            health: {
                status: 'down',
                consecutiveFailures: 5,
                circuitState: 'open',
                lastChecked: freshTimestamp,
                isFresh: true
            }
        },
        {
            providerId: 'addon-2',
            name: 'Addon 2',
            enabled: true,
            capabilities: ['stream'],
            health: {
                status: 'down',
                consecutiveFailures: 5,
                circuitState: 'open',
                lastChecked: freshTimestamp,
                isFresh: true
            }
        },
        {
            providerId: 'addon-3',
            name: 'Addon 3',
            enabled: true,
            capabilities: ['stream'],
            health: {
                status: 'healthy',
                consecutiveSuccesses: 10,
                circuitState: 'closed',
                lastChecked: freshTimestamp,
                isFresh: true
            }
        }
    ];

    const mockManager = {
        list: () => mockAddons,
        getStreamEnabled: () => mockAddons,
        getSubtitleEnabled: () => [],
        getRevision: () => 5
    };

    const monitor = new HealthMonitor(mockManager, {
        intervalMinutes: 0,
        autoRefresh: false,
        degradedMinProvidersRatio: 0.50
    });

    const status = await monitor.getServiceStatus();
    assert.equal(status.status, 'degraded');
    assert.equal(status.details.streamProviders.total, 3);
    assert.equal(status.details.streamProviders.usable, 1);
    assert.equal(Math.round(status.details.streamProviders.usableRatio * 100), 33);
    assert.equal(status.incidents.length, 1);
    assert.equal(status.incidents[0].code, 'PROVIDERS_DEGRADED');
});

test('health: getServiceStatus detects stale health checks beyond threshold even if isFresh is true', async () => {
    const staleTimestamp = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago
    const mockAddons = [
        {
            providerId: 'addon-stale',
            name: 'Stale Addon',
            enabled: true,
            capabilities: ['stream'],
            health: {
                status: 'healthy',
                lastChecked: staleTimestamp,
                isFresh: true // fixture setting isFresh: true must not bypass timestamp window
            }
        }
    ];

    const mockManager = {
        list: () => mockAddons,
        getStreamEnabled: () => mockAddons,
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };

    const monitor = new HealthMonitor(mockManager, {
        intervalMinutes: 0,
        autoRefresh: false,
        staleThresholdMinutes: 60
    });

    const status = await monitor.getServiceStatus();
    assert.equal(status.incidents.length, 1);
    assert.equal(status.incidents[0].code, 'STALE_PROVIDER_HEALTH');
    assert.equal(status.providers.staleCount, 1);
});

test('health: getServiceStatus does not count un-checked providers as healthy', async () => {
    const mockAddons = [
        {
            providerId: 'addon-fresh-install',
            name: 'Freshly Installed Addon',
            enabled: true,
            capabilities: ['stream']
            // No health object or lastChecked
        }
    ];

    const mockManager = {
        list: () => mockAddons,
        getStreamEnabled: () => mockAddons,
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };

    const monitor = new HealthMonitor(mockManager, {
        intervalMinutes: 0,
        autoRefresh: false,
        degradedMinProvidersRatio: 0.50
    });

    const status = await monitor.getServiceStatus();
    assert.equal(status.details.streamProviders.usable, 0);
    assert.equal(status.status, 'degraded');
});
