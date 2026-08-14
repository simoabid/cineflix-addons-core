import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../dist/metrics/index.js';

test('metrics: tracks active http requests and proxy streams gauges', async () => {
    const metrics = new MetricsCollector();

    metrics.incrementActiveRequests();
    metrics.incrementActiveRequests();
    assert.equal(metrics.getActiveRequests(), 2);

    metrics.decrementActiveRequests();
    assert.equal(metrics.getActiveRequests(), 1);

    metrics.incrementActiveProxyStreams();
    assert.equal(metrics.getActiveProxyStreams(), 1);
    metrics.decrementActiveProxyStreams();
    assert.equal(metrics.getActiveProxyStreams(), 0);
});

test('metrics: records provider attempts, outcomes, and source extraction counts', async () => {
    const metrics = new MetricsCollector();

    metrics.recordProviderAttempt('torrentio', 'stream');
    metrics.recordProviderAttempt('torrentio', 'stream');
    metrics.recordProviderOutcome('torrentio', 'success', 150);
    metrics.recordProviderOutcome('torrentio', 'timeout', 5000, 'timeout');
    metrics.recordProviderOutcome('torrentio', 'no_result', 200);
    metrics.recordSourceExtracted('torrentio', 4);
    metrics.recordSourceDropped('torrentio', 'missing_stream', 1);
    metrics.recordSourcesDeduped(2);

    const prom = await metrics.toPrometheusText();
    assert.ok(prom.includes('addons_core_provider_attempts_total{provider="torrentio",capability="stream"} 2'));
    assert.ok(prom.includes('addons_core_provider_successes_total{provider="torrentio"} 1'));
    assert.ok(prom.includes('addons_core_provider_timeouts_total{provider="torrentio"} 1'));
    assert.ok(prom.includes('addons_core_provider_no_results_total{provider="torrentio"} 1'));
    assert.ok(prom.includes('addons_core_provider_sources_extracted_total{provider="torrentio"} 4'));
    assert.ok(prom.includes('addons_core_source_dropped_total{provider="torrentio",reason="missing_stream"} 1'));
    assert.ok(prom.includes('addons_core_source_deduped_total 2'));
    assert.ok(prom.includes('addons_core_provider_scrape_duration_seconds_bucket{provider="torrentio",le="0.25"} 2'));
    assert.ok(prom.includes('addons_core_provider_scrape_duration_seconds_bucket{provider="torrentio",le="+Inf"} 3'));
});

test('metrics: records storage operations and latency histograms', async () => {
    const metrics = new MetricsCollector();

    metrics.recordStorageOperation('file_read', 'ok', 12);
    metrics.recordStorageOperation('file_write', 'ok', 45);
    metrics.recordStorageOperation('pg_query', 'error', 150);

    const prom = await metrics.toPrometheusText();
    assert.ok(prom.includes('addons_storage_operations_total{op="file_read",status="ok"} 1'));
    assert.ok(prom.includes('addons_storage_operations_total{op="file_write",status="ok"} 1'));
    assert.ok(prom.includes('addons_storage_operations_total{op="pg_query",status="error"} 1'));
    assert.ok(prom.includes('addons_storage_duration_seconds_bucket{op="file_read",le="0.05"} 1'));
});

test('metrics: records proxy range requests, denied SSRF, and egress bytes', async () => {
    const metrics = new MetricsCollector();

    metrics.recordProxyRangeRequest();
    metrics.recordProxyDeniedSsrf();
    metrics.recordProxyBytes(1024 * 1024 * 5); // 5 MB
    metrics.recordProxyUpstreamError(502);

    const prom = await metrics.toPrometheusText();
    assert.ok(prom.includes('addons_core_proxy_range_requests_total 1'));
    assert.ok(prom.includes('addons_core_proxy_denied_ssrf_total 1'));
    assert.ok(prom.includes('addons_core_proxy_egress_bytes_total 5242880'));
    assert.ok(prom.includes('addons_core_proxy_upstream_errors_total{status="502"} 1'));
});

test('metrics: records job executions and debrid resolutions', async () => {
    const metrics = new MetricsCollector();

    metrics.recordJobExecution('manifest-refresh', 'completed', 450);
    metrics.recordJobExecution('stremio-account-import', 'failed', 1200);
    metrics.recordDebridResolution('realdebrid', 'cached', 80);
    metrics.recordDebridError('realdebrid', 'AUTH_FAILURE');

    const prom = await metrics.toPrometheusText();
    assert.ok(prom.includes('addons_core_jobs_total{type="manifest-refresh",status="completed"} 1'));
    assert.ok(prom.includes('addons_core_jobs_total{type="stremio-account-import",status="failed"} 1'));
    assert.ok(prom.includes('addons_core_debrid_resolutions_total{provider="realdebrid",outcome="cached"} 1'));
    assert.ok(prom.includes('addons_core_debrid_errors_total{provider="realdebrid",error="AUTH_FAILURE"} 1'));
    assert.ok(prom.includes('addons_http_queue_depth 0'));
});

test('metrics: evaluateSlo calculates availability, error budget, and p95 latency SLOs', () => {
    const metrics = new MetricsCollector();

    // 999 requests of 50ms (200 OK) + 1 request of 500ms (500 Error)
    for (let i = 0; i < 999; i++) {
        metrics.recordHttpRequest('GET', '/v1/movies/550/providers/torrentio', 200, 50);
    }
    metrics.recordHttpRequest('GET', '/v1/movies/550/providers/torrentio', 500, 500);

    const slo = metrics.evaluateSlo();
    assert.equal(slo.totalRequests, 1000);
    assert.equal(slo.successfulRequests, 999);
    assert.equal(slo.failedRequests, 1);
    assert.equal(slo.availabilityRatio, 0.999);
    assert.equal(slo.availabilitySloMet, true);
    assert.equal(slo.p95LatencyMs, 50);
    assert.equal(slo.p95Met, true);
    // 0.1% error rate on 0.1% target budget = 0% error budget remaining
    assert.equal(slo.errorBudgetRemainingPercent, 0);
});

test('metrics: evaluateSlo with manager does not treat unchecked providers as healthy', () => {
    const metrics = new MetricsCollector();
    const mockManager = {
        list: () => [
            {
                providerId: 'torrentio',
                enabled: true,
                manifest: { resources: ['stream'] }
                // no health or lastChecked
            },
            {
                providerId: 'mediafusion',
                enabled: true,
                manifest: { resources: ['stream'] },
                health: {
                    healthy: true,
                    lastChecked: new Date().toISOString()
                }
            }
        ]
    };

    const slo = metrics.evaluateSlo(mockManager);
    assert.equal(slo.providerSuccessRate, 50); // 1 healthy out of 2 enabled stream providers
});

test('metrics: histogram _count strictly matches +Inf bucket across all histograms', async () => {
    const metrics = new MetricsCollector();
    metrics.recordHttpRequest('GET', '/v1/streams', 200, 45);
    metrics.recordProviderOutcome('torrentio', 'success', 120);
    metrics.recordProviderOutcome('torrentio', 'failure', 300, 'network_error');
    metrics.recordStorageOperation('file_read', 'ok', 10);

    const prom = await metrics.toPrometheusText();

    // Check request duration
    assert.ok(prom.includes('addons_http_request_duration_seconds_bucket{method="GET",route="/v1/streams",status="200",le="+Inf"} 1'));
    assert.ok(prom.includes('addons_http_request_duration_seconds_count{method="GET",route="/v1/streams",status="200"} 1'));

    // Check provider scrape duration (2 observations total: 1 success + 1 failure)
    assert.ok(prom.includes('addons_core_provider_scrape_duration_seconds_bucket{provider="torrentio",le="+Inf"} 2'));
    assert.ok(prom.includes('addons_core_provider_scrape_duration_seconds_count{provider="torrentio"} 2'));

    // Check storage duration
    assert.ok(prom.includes('addons_storage_duration_seconds_bucket{op="file_read",le="+Inf"} 1'));
    assert.ok(prom.includes('addons_storage_duration_seconds_count{op="file_read"} 1'));
});
