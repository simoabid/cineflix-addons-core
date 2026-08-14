import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { MetricsCollector } from '../dist/metrics/index.js';

test('MetricsCollector tracks HTTP requests and duration', async () => {
    const collector = new MetricsCollector();
    collector.recordHttpRequest('GET', '/v1/movies/550', 200, 150);
    collector.recordHttpRequest('GET', '/v1/movies/550', 200, 100);
    collector.recordHttpRequest('GET', '/v1/addons', 200, 25);
    collector.recordHttpRequest('GET', '/v1/notfound', 404, 10);

    const snap = await collector.snapshot({});
    assert.ok(snap);
    assert.ok(Array.isArray(snap.requests));
    const movieReq = snap.requests.find((r) => r.route === '/v1/movies/:id');
    assert.ok(movieReq);
    assert.equal(movieReq.count, 2);
    assert.equal(movieReq.totalDurationMs, 250);
});

test('MetricsCollector formats valid Prometheus exposition text', async () => {
    const collector = new MetricsCollector();
    collector.recordHttpRequest('GET', '/v1/movies/550', 200, 150);

    const mockManager = {
        list: () => [{ providerId: 'addon:test', enabled: true, health: { healthy: true } }],
        getStreamEnabled: () => [{ providerId: 'addon:test' }],
        getSubtitleEnabled: () => [],
        getRevision: () => 5
    };

    const text = await collector.toPrometheusText({ manager: mockManager });

    assert.ok(text.includes('# HELP addons_uptime_seconds'));
    assert.ok(text.includes('# TYPE addons_uptime_seconds gauge'));
    assert.ok(text.includes('addons_http_requests_total{method="GET",route="/v1/movies/:id",status="200"} 1'));
    assert.ok(text.includes('addons_http_request_duration_seconds_bucket{method="GET",route="/v1/movies/:id",status="200",le="0.25"} 1'));
    assert.ok(text.includes('addons_http_request_duration_seconds_bucket{method="GET",route="/v1/movies/:id",status="200",le="+Inf"} 1'));
    assert.ok(text.includes('addons_http_request_duration_seconds_sum{method="GET",route="/v1/movies/:id",status="200"} 0.1500'));
    assert.ok(text.includes('addons_http_request_duration_seconds_count{method="GET",route="/v1/movies/:id",status="200"} 1'));
    assert.ok(text.includes('addons_providers_total{type="all"} 1'));
    assert.ok(text.includes('addons_provider_revision 5'));
});

test('Metrics HTTP route supports Prometheus and JSON negotiation', async () => {
    const collector = new MetricsCollector();
    collector.recordHttpRequest('GET', '/v1/providers', 200, 50);

    const app = fastify();

    app.get('/metrics', async (req, reply) => {
        const format = req.query.format;
        if (format === 'json') {
            const snap = await collector.snapshot({});
            return reply.header('Content-Type', 'application/json').code(200).send(snap);
        }
        const text = await collector.toPrometheusText({});
        return reply.header('Content-Type', 'text/plain; version=0.0.4').code(200).send(text);
    });

    // 1. Default Prometheus text
    const resText = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(resText.statusCode, 200);
    assert.ok(resText.headers['content-type'].includes('text/plain'));
    assert.ok(resText.body.includes('addons_http_requests_total'));

    // 2. JSON format query parameter
    const resJson = await app.inject({ method: 'GET', url: '/metrics?format=json' });
    assert.equal(resJson.statusCode, 200);
    assert.ok(resJson.headers['content-type'].includes('application/json'));
    const bodyJson = JSON.parse(resJson.body);
    assert.ok(bodyJson.requests);
});
