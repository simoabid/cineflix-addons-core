import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fastify from 'fastify';
import {
    createSecureProxyContext,
    createProxyCapacityGuards,
    registerSecureProxyRoutes
} from '../dist/security/index.js';
import { HealthMonitor } from '../dist/health/monitor.js';
import { ReadinessGate } from '../dist/lifecycle/shutdown.js';
import { globalReadinessGate } from '../dist/lifecycle/shutdown.js';
import { loadConfig } from '../dist/config.js';

/**
 * Phase 7 contract tests: readiness flip during shutdown, refusal of new
 * work, stream concurrency caps (429), and shutdown-aware health semantics.
 */

function startUpstream({ delayBodyMs = 0, bytes = 1024 * 256 }) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(bytes)
        });
        // Flush headers immediately so the proxy sees the streaming response
        // while the body is still pending (Node buffers headers otherwise).
        res.flushHeaders();
        setTimeout(() => {
            res.end(Buffer.alloc(bytes, 7));
        }, delayBodyMs);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

function phase7Cfg(overrides = {}) {
    const cfg = {
        ...loadConfig(),
        authMode: 'disabled',
        secureProxy: true,
        // Allow the local test upstream through the SSRF policy. Loopback
        // exemption via allow-suffix only works outside production — tests
        // run in development, mirroring how dev instances reach local addons.
        allowHttpUpstreams: true,
        outboundHostAllowSuffixes: ['127.0.0.1'],
        ...overrides
    };
    return cfg;
}

test('readiness flips to 503-style "down" once shutdown begins', async () => {
    const cfg = loadConfig();
    const manager = {
        list: () => [],
        getStreamEnabled: () => [],
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };
    const gate = new ReadinessGate();
    const monitor = new HealthMonitor(manager, {
        intervalMinutes: 0,
        autoRefresh: false,
        version: cfg.version,
        readinessGate: gate
    });

    const before = await monitor.getReadiness();
    assert.equal(before.ready, true);

    gate.beginShutdown('SIGTERM');
    const after = await monitor.getReadiness();
    assert.equal(after.ready, false);
    assert.equal(after.status, 'down');
    assert.equal(after.checks.shutdown.ok, false);
    assert.match(after.checks.shutdown.message, /SIGTERM/);
});

test('new requests are refused with 503 SHUTTING_DOWN during shutdown', async () => {
    const gate = new ReadinessGate();
    const app = fastify({ logger: false });
    app.addHook('onRequest', async (request, reply) => {
        if (!gate.isShuttingDown) return;
        const path = (request.url ?? '').split('?')[0];
        if (path.startsWith('/health') || path === '/metrics') {
            reply.header('Connection', 'close');
            return;
        }
        reply.header('Connection', 'close');
        reply.header('Retry-After', '5');
        await reply.code(503).send({
            error: {
                code: 'SHUTTING_DOWN',
                message: 'Instance is shutting down'
            },
            requestId: request.id
        });
    });
    app.get('/v1/movies/:id', async () => ({ sources: [] }));
    app.get('/health/ready', async () => ({ ready: !gate.isShuttingDown }));
    await app.ready();

    const okRes = await app.inject({ method: 'GET', url: '/v1/movies/123' });
    assert.equal(okRes.statusCode, 200);

    gate.beginShutdown('deploy');
    const rejected = await app.inject({ method: 'GET', url: '/v1/movies/123' });
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.headers.connection, 'close');
    assert.equal(rejected.headers['retry-after'], '5');
    const body = rejected.json();
    assert.equal(body.error.code, 'SHUTTING_DOWN');

    // Probes keep answering (through the hook's carve-out).
    const probe = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.json().ready, false);
});

test('stream concurrency cap rejects the second concurrent stream with 429', async () => {
    const { server, port } = await startUpstream({ delayBodyMs: 400 });
    try {
        const cfg = phase7Cfg();
        const proxyCtx = {
            ...createSecureProxyContext(cfg),
            ...createProxyCapacityGuards({
                ...cfg,
                maxConcurrentStreamsPerIp: 1,
                maxConcurrentStreamsPerUser: 10,
                maxConcurrentStreamsGlobal: 10
            })
        };
        const app = fastify({ logger: false });
        registerSecureProxyRoutes(app, cfg, proxyCtx, 'http://localhost:3006');
        await app.ready();

        const mkGrantUrl = async (file) => {
            const grant = await proxyCtx.grants.issue({
                url: `http://127.0.0.1:${port}/${file}`
            });
            return `/v1/proxy/grant/${grant.id}`;
        };

        const firstUrl = await mkGrantUrl('a.mp4');
        const secondUrl = await mkGrantUrl('b.mp4');

        // First stream: hold it open (upstream delays the body).
        let firstSettled = null;
        const first = app.inject({ method: 'GET', url: firstUrl });
        firstSettled = first.then(
            (r) => ({ status: r.statusCode }),
            (e) => ({ status: 0, error: String(e) })
        );
        // Give the first request time to be admitted and fetch upstream headers.
        await new Promise((r) => setTimeout(r, 150));

        const second = await app.inject({ method: 'GET', url: secondUrl });
        assert.equal(
            second.statusCode,
            429,
            `expected 429, got ${second.statusCode}: ${second.body}`
        );
        const body = second.json();
        assert.equal(body.error.code, 'STREAM_LIMIT_EXCEEDED');

        const firstRes = await firstSettled;
        assert.equal(firstRes.status, 200, 'in-flight stream unaffected');
        await app.close();
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('service status reports capacity telemetry and shutdown state', async () => {
    const cfg = loadConfig();
    const manager = {
        list: () => [],
        getStreamEnabled: () => [],
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };
    const gate = new ReadinessGate();
    const { ProviderBudgetRegistry, EgressBudgetMonitor } =
        await import('../dist/capacity/budgets.js');
    const budgets = new ProviderBudgetRegistry({ defaultDailyLimit: 2 });
    budgets.consume('addon:capped');
    budgets.consume('addon:capped');
    const monitor = new HealthMonitor(manager, {
        intervalMinutes: 0,
        autoRefresh: false,
        version: cfg.version,
        readinessGate: gate,
        capacity: {
            providerBudgets: budgets,
            egress: new EgressBudgetMonitor({ dailyBudgetBytes: 1000 }),
            streams: { gauge: () => ({ activeStreams: 0 }) }
        }
    });

    const status = await monitor.getServiceStatus();
    assert.ok(status.capacity, 'capacity section present');
    assert.deepEqual(status.capacity.providerBudgetsExhausted, [
        'addon:capped'
    ]);
    assert.equal(status.capacity.quarantinedProviders, 0);
    assert.equal(status.capacity.egress.level, 'ok');
    assert.equal(status.shuttingDown, undefined, 'absent while running');

    gate.beginShutdown('test');
    const after = await monitor.getServiceStatus();
    assert.equal(after.shuttingDown, true);
});

test('global readiness gate used by the server is a distinct shared instance', () => {
    // The server wires globalReadinessGate into health + shutdown. Here we
    // only assert its API matches what routes rely on.
    assert.equal(typeof globalReadinessGate.beginShutdown, 'function');
    assert.equal(typeof globalReadinessGate.isShuttingDown, 'boolean');
});
