import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { HealthMonitor } from '../dist/health/monitor.js';

test('HealthMonitor liveness, readiness, and dependencies return structured status', async () => {
    const mockManager = {
        list: () => [{ providerId: 'addon:test', enabled: true }],
        getStreamEnabled: () => [{ providerId: 'addon:test', manifestUrl: 'http://test' }],
        getRevision: () => 1
    };

    const monitor = new HealthMonitor(mockManager, { intervalMinutes: 0, autoRefresh: false });

    // 1. Liveness
    const live = monitor.getLiveness();
    assert.equal(live.status, 'ok');
    assert.equal(typeof live.uptimeSec, 'number');
    assert.ok(live.timestamp);
    assert.ok(live.memory.heapUsedMb > 0);

    // 2. Readiness
    const ready = await monitor.getReadiness();
    assert.equal(ready.status, 'ok');
    assert.equal(ready.ready, true);
    assert.ok(ready.checks.manager.ok);

    // 3. Dependencies
    const deps = await monitor.getDependencies();
    assert.ok(deps.status === 'ok' || deps.status === 'degraded');
    assert.ok(Array.isArray(deps.dependencies));
    const tmdbDep = deps.dependencies.find((d) => d.name === 'TMDB');
    assert.ok(tmdbDep);
    assert.equal(tmdbDep.type, 'upstream_api');
});

test('Health probe HTTP routes return proper status codes', async () => {
    const mockManager = {
        list: () => [],
        getStreamEnabled: () => [],
        getRevision: () => 1
    };
    const monitor = new HealthMonitor(mockManager, { intervalMinutes: 0, autoRefresh: false });

    const app = fastify();

    app.get('/health/live', async (_req, reply) => {
        return reply.code(200).send(monitor.getLiveness());
    });
    app.get('/health/ready', async (_req, reply) => {
        const report = await monitor.getReadiness();
        return reply.code(report.ready ? 200 : 503).send(report);
    });
    app.get('/health/dependencies', async (_req, reply) => {
        const deps = await monitor.getDependencies();
        return reply.code(deps.status === 'down' ? 503 : 200).send(deps);
    });

    const resLive = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(resLive.statusCode, 200);
    const bodyLive = JSON.parse(resLive.body);
    assert.equal(bodyLive.status, 'ok');

    const resReady = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(resReady.statusCode, 200);

    const resDeps = await app.inject({ method: 'GET', url: '/health/dependencies' });
    assert.equal(resDeps.statusCode, 200);
});

test('Readiness probe fails with 503 degraded status when cache snapshot throws', async () => {
    const mockManager = {
        list: () => [],
        getStreamEnabled: () => [],
        getRevision: () => 1
    };
    const monitor = new HealthMonitor(mockManager, { intervalMinutes: 0, autoRefresh: false });

    const failingCache = {
        snapshot: () => {
            throw new Error('Redis connection timeout');
        }
    };

    const report = await monitor.getReadiness({ cache: failingCache });
    assert.equal(report.ready, false);
    assert.equal(report.status, 'degraded');
    assert.equal(report.checks.cache.ok, false);

    const app = fastify();
    app.get('/health/ready', async (_req, reply) => {
        const rep = await monitor.getReadiness({ cache: failingCache });
        return reply.code(rep.ready ? 200 : 503).send(rep);
    });

    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.ready, false);
    assert.equal(body.status, 'degraded');
});
