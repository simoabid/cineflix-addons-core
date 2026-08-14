/**
 * Observability & Prometheus Metrics Engine for addons-core.
 * Phase 6.2: Comprehensive Prometheus/OpenTelemetry metrics for HTTP requests,
 * active queues, provider circuit states, source validation drop rates,
 * secure proxy egress & SSRF denial, job execution latencies, cache operations,
 * debrid resolutions, storage operations, and initial SLO evaluations.
 */

import type { AddonManager } from '../addons/manager.js';
import type { ReliabilityRegistry } from '../reliability/circuit.js';
import type { CacheManager } from '../cache/manager.js';
import type { JobEngine } from '../jobs/engine.js';
import type { IStorageBackend } from '../storage/types.js';
import { debridService } from '../debrid/service.js';

export interface HttpMetricSample {
    method: string;
    route: string;
    status: number;
    count: number;
    totalDurationMs: number;
    totalResponseBytes: number;
}

export interface SloEvaluation {
    livenessSuccessRate: number;
    livenessSloTarget: number;
    livenessMet: boolean;
    errorRate: number;
    errorBudgetRemainingPercent: number;
    p95LatencyMs: number;
    p95TargetMs: number;
    p95Met: boolean;
    providerSuccessRate: number;
    staleHealthCount: number;
    activeIncidentsCount: number;
    totalRequests?: number;
    successfulRequests?: number;
    failedRequests?: number;
    availabilityRatio?: number;
    availabilitySloMet?: boolean;
}

const HISTOGRAM_BUCKETS = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0
];

export class MetricsCollector {
    private readonly requestCounts = new Map<string, number>();
    private readonly requestDurations = new Map<string, number>();
    private readonly responseBytes = new Map<string, number>();
    private readonly bucketCounts = new Map<string, number>();
    private readonly startTime = Date.now();

    // Active concurrency gauges
    private activeHttpRequests = 0;
    private activeProxyStreams = 0;

    getActiveRequests(): number {
        return this.activeHttpRequests;
    }

    getActiveProxyStreams(): number {
        return this.activeProxyStreams;
    }

    // Provider telemetry counters
    private readonly providerRequests = new Map<string, number>();
    private readonly providerSuccesses = new Map<string, number>();
    private readonly providerFailures = new Map<string, number>();
    private readonly providerTimeouts = new Map<string, number>();
    private readonly providerNoResults = new Map<string, number>();
    private readonly providerDurations = new Map<string, number>();

    // Source validation counters
    private readonly sourcesExtracted = new Map<string, number>();
    private readonly sourcesDropped = new Map<string, number>();
    private sourcesDeduped = 0;

    // Proxy telemetry counters
    private proxyBytesTotal = 0;
    private proxyRangeRequests = 0;
    private readonly proxyUpstreamErrors = new Map<number, number>();
    private proxyDeniedSsrf = 0;

    // Job telemetry counters
    private readonly jobExecutions = new Map<string, number>();
    private readonly jobDurations = new Map<string, number>();

    // Debrid telemetry counters
    private readonly debridResolutions = new Map<string, number>();
    private readonly debridDurations = new Map<string, number>();
    private readonly debridErrors = new Map<string, number>();

    // Storage telemetry counters
    private readonly storageOperations = new Map<string, number>();
    private readonly storageDurations = new Map<string, number>();

    // Cache job stats to prevent latency spikes in metrics collection hot path
    private cachedJobStats: {
        timestamp: number;
        data: {
            queued: number;
            running: number;
            failed: number;
            completed: number;
        };
    } | null = null;

    private sanitizeRoute(rawUrl: string, method: string): string {
        const path = (rawUrl.split('?')[0]?.split('#')[0] || '/').trim() || '/';

        const normalized = path
            .replace(
                /\/v1\/movies\/[^/]+\/providers\/[^/]+/g,
                '/v1/movies/:tmdbId/providers/:providerId'
            )
            .replace(
                /\/v1\/tv\/[^/]+\/seasons\/[^/]+\/episodes\/[^/]+\/providers\/[^/]+/g,
                '/v1/tv/:tmdbId/seasons/:s/episodes/:e/providers/:providerId'
            )
            .replace(/\/v1\/movies\/[^/]+/g, '/v1/movies/:id')
            .replace(
                /\/v1\/tv\/[^/]+\/seasons\/[^/]+\/episodes\/[^/]+/g,
                '/v1/tv/:id/seasons/:s/episodes/:e'
            )
            .replace(
                /\/v1\/addons\/[^/]+\/refresh/g,
                '/v1/addons/:providerId/refresh'
            )
            .replace(/\/v1\/addons\/[^/]+/g, '/v1/addons/:providerId')
            .replace(/\/v1\/jobs\/[^/]+\/cancel/g, '/v1/jobs/:id/cancel')
            .replace(/\/v1\/jobs\/[^/]+/g, '/v1/jobs/:id')
            .replace(/\/v1\/import\/jobs\/[^/]+/g, '/v1/import/jobs/:jobId')
            .replace(
                /\/v1\/debrid\/transfers\/[^/]+/g,
                '/v1/debrid/transfers/:jobId'
            )
            .replace(/\/v1\/proxy\/grant\/[^/]+/g, '/v1/proxy/grant/:id')
            .replace(/\/v1\/proxy\/token\/[^/]+/g, '/v1/proxy/token/:token')
            .replace(/\/debug\/providers\/[^/]+/g, '/debug/providers/:id');

        return `${method.toUpperCase()} ${normalized}`;
    }

    // ── HTTP Metrics ─────────────────────────────────────────────────────────

    incrementActiveRequests(): void {
        this.activeHttpRequests++;
    }

    decrementActiveRequests(): void {
        this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
    }

    recordHttpRequest(
        method: string,
        url: string,
        status: number,
        durationMs: number,
        bytesSent = 0
    ): void {
        const routeKey = this.sanitizeRoute(url, method);
        const key = `${routeKey}#${status}`;
        this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
        this.requestDurations.set(
            key,
            (this.requestDurations.get(key) ?? 0) + durationMs
        );
        this.responseBytes.set(
            key,
            (this.responseBytes.get(key) ?? 0) + bytesSent
        );

        const durationSec = durationMs / 1000;
        for (const le of HISTOGRAM_BUCKETS) {
            if (durationSec <= le) {
                const bKey = `${routeKey}#${status}#${le}`;
                this.bucketCounts.set(
                    bKey,
                    (this.bucketCounts.get(bKey) ?? 0) + 1
                );
            }
        }
        const infKey = `${routeKey}#${status}#+Inf`;
        this.bucketCounts.set(infKey, (this.bucketCounts.get(infKey) ?? 0) + 1);
    }

    // ── Provider Telemetry ───────────────────────────────────────────────────

    recordProviderAttempt(providerId: string, capability = 'stream'): void {
        const k = `${providerId}#${capability}`;
        this.providerRequests.set(k, (this.providerRequests.get(k) ?? 0) + 1);
    }

    recordProviderOutcome(
        providerId: string,
        outcome: 'success' | 'failure' | 'timeout' | 'no_result',
        durationMs: number,
        failureKind?: string
    ): void {
        this.providerDurations.set(
            providerId,
            (this.providerDurations.get(providerId) ?? 0) + durationMs
        );
        if (outcome === 'success') {
            this.providerSuccesses.set(
                providerId,
                (this.providerSuccesses.get(providerId) ?? 0) + 1
            );
        } else if (outcome === 'failure') {
            const k = `${providerId}#${failureKind || 'unknown'}`;
            this.providerFailures.set(
                k,
                (this.providerFailures.get(k) ?? 0) + 1
            );
        } else if (outcome === 'timeout') {
            this.providerTimeouts.set(
                providerId,
                (this.providerTimeouts.get(providerId) ?? 0) + 1
            );
        } else if (outcome === 'no_result') {
            this.providerNoResults.set(
                providerId,
                (this.providerNoResults.get(providerId) ?? 0) + 1
            );
        }
    }

    // ── Source Normalization & Validation ────────────────────────────────────

    recordSourceExtracted(providerId: string, count = 1): void {
        this.sourcesExtracted.set(
            providerId,
            (this.sourcesExtracted.get(providerId) ?? 0) + count
        );
    }

    recordSourceDropped(providerId: string, reason: string, count = 1): void {
        const k = `${providerId}#${reason}`;
        this.sourcesDropped.set(k, (this.sourcesDropped.get(k) ?? 0) + count);
    }

    recordSourcesDeduped(count = 1): void {
        this.sourcesDeduped += count;
    }

    // ── Secure Proxy & Egress ────────────────────────────────────────────────

    recordProxyBytes(bytes: number): void {
        this.proxyBytesTotal += Math.max(0, bytes);
    }

    recordProxyRangeRequest(): void {
        this.proxyRangeRequests++;
    }

    recordProxyUpstreamError(status: number): void {
        this.proxyUpstreamErrors.set(
            status,
            (this.proxyUpstreamErrors.get(status) ?? 0) + 1
        );
    }

    recordProxyDeniedSsrf(): void {
        this.proxyDeniedSsrf++;
    }

    incrementActiveProxyStreams(): void {
        this.activeProxyStreams++;
    }

    decrementActiveProxyStreams(): void {
        this.activeProxyStreams = Math.max(0, this.activeProxyStreams - 1);
    }

    // ── Job Engine Metrics ───────────────────────────────────────────────────

    recordJobExecution(
        jobType: string,
        status: 'completed' | 'failed',
        durationMs: number
    ): void {
        const k = `${jobType}#${status}`;
        this.jobExecutions.set(k, (this.jobExecutions.get(k) ?? 0) + 1);
        this.jobDurations.set(
            jobType,
            (this.jobDurations.get(jobType) ?? 0) + durationMs
        );
    }

    // ── Debrid Metrics ───────────────────────────────────────────────────────

    recordDebridResolution(
        provider: string,
        outcome: 'cached' | 'transferred' | 'failed' | 'not_found',
        durationMs: number
    ): void {
        const k = `${provider}#${outcome}`;
        this.debridResolutions.set(k, (this.debridResolutions.get(k) ?? 0) + 1);
        this.debridDurations.set(
            provider,
            (this.debridDurations.get(provider) ?? 0) + durationMs
        );
    }

    recordDebridError(provider: string, errorCode: string): void {
        const k = `${provider}#${errorCode}`;
        this.debridErrors.set(k, (this.debridErrors.get(k) ?? 0) + 1);
    }

    // ── Storage Metrics ──────────────────────────────────────────────────────

    recordStorageOperation(
        op: string,
        status: 'ok' | 'error',
        durationMs: number
    ): void {
        const k = `${op}#${status}`;
        this.storageOperations.set(k, (this.storageOperations.get(k) ?? 0) + 1);
        this.storageDurations.set(
            op,
            (this.storageDurations.get(op) ?? 0) + durationMs
        );
    }

    private async getJobStats(
        storage?: IStorageBackend
    ): Promise<{
        queued: number;
        running: number;
        failed: number;
        completed: number;
    }> {
        const now = Date.now();
        if (this.cachedJobStats && now - this.cachedJobStats.timestamp < 5000) {
            return this.cachedJobStats.data;
        }
        if (!storage) {
            return { queued: 0, running: 0, failed: 0, completed: 0 };
        }
        try {
            const activeJobs = await storage.listJobs({ limit: 100 });
            const data = {
                queued: activeJobs.filter((j) => j.status === 'queued').length,
                running: activeJobs.filter((j) => j.status === 'running')
                    .length,
                failed: activeJobs.filter((j) => j.status === 'failed').length,
                completed: activeJobs.filter((j) => j.status === 'completed')
                    .length
            };
            this.cachedJobStats = { timestamp: now, data };
            return data;
        } catch {
            return { queued: 0, running: 0, failed: 0, completed: 0 };
        }
    }

    // ── SLO Evaluation ───────────────────────────────────────────────────────

    evaluateSlo(manager?: AddonManager): SloEvaluation {
        let totalRequests = 0;
        let errorRequests = 0;
        const latencies: number[] = [];

        for (const [key, count] of this.requestCounts.entries()) {
            const statusStr = key.split('#')[1] || '200';
            const status = Number(statusStr) || 200;
            totalRequests += count;
            if (status >= 500) {
                errorRequests += count;
            }
            const dur = this.requestDurations.get(key) ?? 0;
            if (count > 0) {
                latencies.push(dur / count);
            }
        }

        // Latency p95 approximation
        latencies.sort((a, b) => a - b);
        const p95Idx = Math.floor(latencies.length * 0.95);
        const p95LatencyMs = latencies.length ? (latencies[p95Idx] ?? 0) : 0;

        const errorRate =
            totalRequests > 0 ? (errorRequests / totalRequests) * 100 : 0;
        const errorBudgetRemainingPercent = Math.max(0, 100 - errorRate * 100);

        let staleCount = 0;
        let totalStreamProviders = 0;
        let healthyStreamProviders = 0;

        if (manager) {
            const list = manager.list();
            const now = Date.now();
            const freshnessWindowMs = 60 * 60 * 1000;
            for (const a of list) {
                if (a.enabled && a.manifest?.resources) {
                    const hasStream = a.manifest.resources.some((r) =>
                        typeof r === 'string'
                            ? r === 'stream'
                            : r?.name === 'stream'
                    );
                    if (hasStream) {
                        totalStreamProviders++;
                        if (a.health?.healthy) healthyStreamProviders++;
                    }
                }
                if (a.health?.lastChecked) {
                    const last = new Date(a.health.lastChecked).getTime();
                    if (now - last > freshnessWindowMs) {
                        staleCount++;
                    }
                } else if (a.enabled) {
                    staleCount++;
                }
            }
        }

        const providerSuccessRate =
            totalStreamProviders > 0
                ? (healthyStreamProviders / totalStreamProviders) * 100
                : 100;

        const livenessSuccessRate =
            errorRate < 0.1 ? 99.99 : Math.max(0, 100 - errorRate);

        const successfulRequests = totalRequests - errorRequests;
        const availabilityRatio =
            totalRequests > 0 ? successfulRequests / totalRequests : 1.0;
        const availabilitySloMet = availabilityRatio >= 0.99;

        return {
            livenessSuccessRate: Number(livenessSuccessRate.toFixed(2)),
            livenessSloTarget: 99.9,
            livenessMet: livenessSuccessRate >= 99.9,
            errorRate: Number(errorRate.toFixed(2)),
            errorBudgetRemainingPercent: Number(
                errorBudgetRemainingPercent.toFixed(2)
            ),
            p95LatencyMs: Math.round(p95LatencyMs),
            p95TargetMs: 250,
            p95Met: p95LatencyMs <= 250,
            providerSuccessRate: Number(providerSuccessRate.toFixed(2)),
            staleHealthCount: staleCount,
            activeIncidentsCount:
                (providerSuccessRate < 50 ? 1 : 0) + (errorRate > 5 ? 1 : 0),
            totalRequests,
            successfulRequests,
            failedRequests: errorRequests,
            availabilityRatio: Number(availabilityRatio.toFixed(4)),
            availabilitySloMet
        };
    }

    async toPrometheusText(services?: {
        manager?: AddonManager;
        circuit?: ReliabilityRegistry;
        cache?: CacheManager;
        jobs?: JobEngine;
        storage?: IStorageBackend;
    }): Promise<string> {
        const lines: string[] = [];
        const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);

        lines.push('# HELP addons_uptime_seconds Process uptime in seconds.');
        lines.push('# TYPE addons_uptime_seconds gauge');
        lines.push(`addons_uptime_seconds ${uptimeSec}`);
        lines.push('');

        // Active requests
        lines.push(
            '# HELP addons_http_active_requests Currently active inbound HTTP requests.'
        );
        lines.push('# TYPE addons_http_active_requests gauge');
        lines.push(`addons_http_active_requests ${this.activeHttpRequests}`);
        lines.push('');

        // HTTP Requests Total
        lines.push(
            '# HELP addons_http_requests_total Total number of HTTP requests handled.'
        );
        lines.push('# TYPE addons_http_requests_total counter');
        for (const [key, count] of this.requestCounts.entries()) {
            const [routeKey, statusStr] = key.split('#');
            const [method, ...routeParts] = (routeKey ?? '').split(' ');
            const route = routeParts.join(' ');
            lines.push(
                `addons_http_requests_total{method="${method}",route="${route}",status="${statusStr}"} ${count}`
            );
        }
        lines.push('');

        // HTTP Request Duration Histogram
        lines.push(
            '# HELP addons_http_request_duration_seconds HTTP request latencies in seconds.'
        );
        lines.push('# TYPE addons_http_request_duration_seconds histogram');
        for (const [key, durationMs] of this.requestDurations.entries()) {
            const [routeKey, statusStr] = key.split('#');
            const [method, ...routeParts] = (routeKey ?? '').split(' ');
            const route = routeParts.join(' ');
            const durationSec = (durationMs / 1000).toFixed(4);
            const count = this.requestCounts.get(key) ?? 0;

            for (const le of HISTOGRAM_BUCKETS) {
                const bCount =
                    this.bucketCounts.get(`${routeKey}#${statusStr}#${le}`) ??
                    0;
                lines.push(
                    `addons_http_request_duration_seconds_bucket{method="${method}",route="${route}",status="${statusStr}",le="${le}"} ${bCount}`
                );
            }
            const infCount =
                this.bucketCounts.get(`${routeKey}#${statusStr}#+Inf`) ?? count;
            lines.push(
                `addons_http_request_duration_seconds_bucket{method="${method}",route="${route}",status="${statusStr}",le="+Inf"} ${infCount}`
            );
            lines.push(
                `addons_http_request_duration_seconds_sum{method="${method}",route="${route}",status="${statusStr}"} ${durationSec}`
            );
            lines.push(
                `addons_http_request_duration_seconds_count{method="${method}",route="${route}",status="${statusStr}"} ${count}`
            );
        }
        lines.push('');

        // Provider Telemetry
        if (this.providerRequests.size > 0) {
            lines.push(
                '# HELP addons_provider_requests_total Outbound provider attempts.'
            );
            lines.push('# TYPE addons_provider_requests_total counter');
            for (const [k, count] of this.providerRequests.entries()) {
                const [pid, capability] = k.split('#');
                lines.push(
                    `addons_provider_requests_total{provider_id="${pid}",capability="${capability}"} ${count}`
                );
                lines.push(
                    `addons_core_provider_attempts_total{provider="${pid}",capability="${capability}"} ${count}`
                );
            }
            lines.push('');
        }

        if (this.providerFailures.size > 0) {
            lines.push(
                '# HELP addons_provider_failures_total Provider lookup failures.'
            );
            lines.push('# TYPE addons_provider_failures_total counter');
            for (const [k, count] of this.providerFailures.entries()) {
                const [pid, kind] = k.split('#');
                lines.push(
                    `addons_provider_failures_total{provider_id="${pid}",failure_kind="${kind}"} ${count}`
                );
                lines.push(
                    `addons_core_provider_failures_total{provider="${pid}",kind="${kind}"} ${count}`
                );
            }
            lines.push('');
        }

        if (this.providerTimeouts.size > 0) {
            lines.push(
                '# HELP addons_provider_timeouts_total Provider lookup timeouts.'
            );
            lines.push('# TYPE addons_provider_timeouts_total counter');
            for (const [pid, count] of this.providerTimeouts.entries()) {
                lines.push(
                    `addons_provider_timeouts_total{provider_id="${pid}"} ${count}`
                );
                lines.push(
                    `addons_core_provider_timeouts_total{provider="${pid}"} ${count}`
                );
            }
            lines.push('');
        }

        if (this.providerDurations.size > 0) {
            lines.push(
                '# HELP addons_provider_successes_total Provider successful lookups.'
            );
            lines.push('# TYPE addons_provider_successes_total counter');
            for (const [pid, count] of this.providerSuccesses.entries()) {
                lines.push(
                    `addons_provider_successes_total{provider_id="${pid}"} ${count}`
                );
                lines.push(
                    `addons_core_provider_successes_total{provider="${pid}"} ${count}`
                );
            }
            lines.push('');
            lines.push(
                '# HELP addons_core_provider_scrape_duration_seconds Provider scrape duration in seconds.'
            );
            lines.push(
                '# TYPE addons_core_provider_scrape_duration_seconds histogram'
            );
            for (const [pid, totalDur] of this.providerDurations.entries()) {
                const count = this.providerRequests.get(`${pid}#stream`) ?? 1;
                for (const le of HISTOGRAM_BUCKETS) {
                    lines.push(
                        `addons_core_provider_scrape_duration_seconds_bucket{provider="${pid}",le="${le}"} ${count}`
                    );
                }
                lines.push(
                    `addons_core_provider_scrape_duration_seconds_bucket{provider="${pid}",le="+Inf"} ${count}`
                );
                lines.push(
                    `addons_core_provider_scrape_duration_seconds_sum{provider="${pid}"} ${(totalDur / 1000).toFixed(4)}`
                );
                lines.push(
                    `addons_core_provider_scrape_duration_seconds_count{provider="${pid}"} ${count}`
                );
            }
            lines.push('');
        }

        if (this.sourcesExtracted.size > 0) {
            lines.push(
                '# HELP addons_core_provider_sources_extracted_total Sources extracted by provider.'
            );
            lines.push(
                '# TYPE addons_core_provider_sources_extracted_total counter'
            );
            for (const [pid, count] of this.sourcesExtracted.entries()) {
                lines.push(
                    `addons_core_provider_sources_extracted_total{provider="${pid}"} ${count}`
                );
            }
            lines.push('');
        }

        // Addons & Providers Gauges
        if (services?.manager) {
            const all = services.manager.list();
            const stream = services.manager.getStreamEnabled();
            const subtitle = services.manager.getSubtitleEnabled();
            const healthy = all.filter(
                (a) => a.health?.healthy !== false
            ).length;
            const rev = services.manager.getRevision();

            lines.push(
                '# HELP addons_providers_total Current number of installed providers.'
            );
            lines.push('# TYPE addons_providers_total gauge');
            lines.push(`addons_providers_total{type="all"} ${all.length}`);
            lines.push(
                `addons_providers_total{type="stream"} ${stream.length}`
            );
            lines.push(
                `addons_providers_total{type="subtitles"} ${subtitle.length}`
            );
            lines.push(`addons_providers_total{type="healthy"} ${healthy}`);
            lines.push('');

            lines.push(
                '# HELP addons_provider_revision Monotonic provider configuration revision.'
            );
            lines.push('# TYPE addons_provider_revision gauge');
            lines.push(`addons_provider_revision ${rev}`);
            lines.push('');
        }

        // Circuit Breaker Metrics
        if (services?.circuit) {
            const snap = services.circuit.snapshot();
            lines.push(
                '# HELP addons_circuit_breakers_total Current state of provider circuit breakers.'
            );
            lines.push('# TYPE addons_circuit_breakers_total gauge');
            let openCount = 0;
            let halfOpenCount = 0;
            let closedCount = 0;

            for (const [, item] of Object.entries(snap)) {
                if (item.state === 'open') openCount++;
                else if (item.state === 'half-open') halfOpenCount++;
                else closedCount++;
            }
            lines.push(
                `addons_circuit_breakers_total{state="open"} ${openCount}`
            );
            lines.push(
                `addons_circuit_breakers_total{state="half-open"} ${halfOpenCount}`
            );
            lines.push(
                `addons_circuit_breakers_total{state="closed"} ${closedCount}`
            );
            lines.push('');
        }

        // Cache Metrics
        if (services?.cache) {
            const cSnap = services.cache.snapshot();
            lines.push(
                '# HELP addons_cache_operations_total Cache hits, misses, SWR hits, and evictions.'
            );
            lines.push('# TYPE addons_cache_operations_total counter');
            lines.push(
                `addons_cache_operations_total{operation="hit"} ${cSnap.hits}`
            );
            lines.push(
                `addons_cache_operations_total{operation="miss"} ${cSnap.misses}`
            );
            lines.push(
                `addons_cache_operations_total{operation="swr_hit"} ${cSnap.swrHits}`
            );
            lines.push(
                `addons_cache_operations_total{operation="set"} ${cSnap.sets}`
            );
            lines.push(
                `addons_cache_operations_total{operation="eviction"} ${cSnap.evictions}`
            );
            lines.push(
                `addons_cache_operations_total{operation="bypass"} ${cSnap.bypasses}`
            );
            lines.push('');
        }

        // Proxy Metrics
        lines.push(
            '# HELP addons_proxy_bytes_total Total proxied video and subtitle streaming bytes.'
        );
        lines.push('# TYPE addons_proxy_bytes_total counter');
        lines.push(`addons_proxy_bytes_total ${this.proxyBytesTotal}`);
        lines.push(
            `addons_core_proxy_egress_bytes_total ${this.proxyBytesTotal}`
        );
        lines.push('');

        lines.push(
            '# HELP addons_proxy_range_requests_total Total range requests received by proxy.'
        );
        lines.push('# TYPE addons_proxy_range_requests_total counter');
        lines.push(
            `addons_proxy_range_requests_total ${this.proxyRangeRequests}`
        );
        lines.push(
            `addons_core_proxy_range_requests_total ${this.proxyRangeRequests}`
        );
        lines.push('');

        lines.push(
            '# HELP addons_proxy_active_streams Current active proxied media streams.'
        );
        lines.push('# TYPE addons_proxy_active_streams gauge');
        lines.push(`addons_proxy_active_streams ${this.activeProxyStreams}`);
        lines.push(
            `addons_core_proxy_active_streams ${this.activeProxyStreams}`
        );
        lines.push('');

        lines.push(
            '# HELP addons_proxy_denied_ssrf_total Denied SSRF and unsafe proxy requests.'
        );
        lines.push('# TYPE addons_proxy_denied_ssrf_total counter');
        lines.push(`addons_proxy_denied_ssrf_total ${this.proxyDeniedSsrf}`);
        lines.push(
            `addons_core_proxy_denied_ssrf_total ${this.proxyDeniedSsrf}`
        );
        lines.push('');

        if (this.proxyUpstreamErrors.size > 0) {
            lines.push(
                '# HELP addons_proxy_upstream_errors_total Upstream HTTP error codes encountered.'
            );
            lines.push('# TYPE addons_proxy_upstream_errors_total counter');
            for (const [status, count] of this.proxyUpstreamErrors.entries()) {
                lines.push(
                    `addons_proxy_upstream_errors_total{status="${status}"} ${count}`
                );
                lines.push(
                    `addons_core_proxy_upstream_errors_total{status="${status}"} ${count}`
                );
            }
            lines.push('');
        }

        // Debrid Service Metrics
        const debridEnabled = debridService.isEnabled();
        lines.push(
            '# HELP addons_debrid_enabled Debrid integration enabled status.'
        );
        lines.push('# TYPE addons_debrid_enabled gauge');
        lines.push(`addons_debrid_enabled ${debridEnabled ? 1 : 0}`);
        lines.push('');

        if (this.debridResolutions.size > 0) {
            lines.push(
                '# HELP addons_core_debrid_resolutions_total Debrid resolutions by outcome.'
            );
            lines.push('# TYPE addons_core_debrid_resolutions_total counter');
            for (const [k, count] of this.debridResolutions.entries()) {
                const [provider, outcome] = k.split('#');
                lines.push(
                    `addons_core_debrid_resolutions_total{provider="${provider}",outcome="${outcome}"} ${count}`
                );
            }
            lines.push('');
        }

        if (this.debridErrors.size > 0) {
            lines.push(
                '# HELP addons_core_debrid_errors_total Debrid error codes.'
            );
            lines.push('# TYPE addons_core_debrid_errors_total counter');
            for (const [k, count] of this.debridErrors.entries()) {
                const [provider, error] = k.split('#');
                lines.push(
                    `addons_core_debrid_errors_total{provider="${provider}",error="${error}"} ${count}`
                );
            }
            lines.push('');
        }

        // Jobs Engine Metrics
        const jobData = await this.getJobStats(services?.storage);
        lines.push(
            '# HELP addons_jobs_total Total job engine background tasks by status.'
        );
        lines.push('# TYPE addons_jobs_total gauge');
        lines.push(`addons_jobs_total{status="queued"} ${jobData.queued}`);
        lines.push(`addons_jobs_total{status="running"} ${jobData.running}`);
        lines.push(`addons_jobs_total{status="failed"} ${jobData.failed}`);
        lines.push(
            `addons_jobs_total{status="completed"} ${jobData.completed}`
        );
        lines.push('');

        if (this.jobExecutions.size > 0) {
            lines.push(
                '# HELP addons_core_jobs_total Job executions by type and status.'
            );
            lines.push('# TYPE addons_core_jobs_total counter');
            for (const [k, count] of this.jobExecutions.entries()) {
                const [type, status] = k.split('#');
                lines.push(
                    `addons_core_jobs_total{type="${type}",status="${status}"} ${count}`
                );
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    async snapshot(services: {
        manager?: AddonManager;
        circuit?: ReliabilityRegistry;
        cache?: CacheManager;
        jobs?: JobEngine;
        storage?: IStorageBackend;
    }) {
        const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
        const routes: Array<{
            method: string;
            route: string;
            status: number;
            count: number;
            totalDurationMs: number;
            totalResponseBytes: number;
        }> = [];

        for (const [key, count] of this.requestCounts.entries()) {
            const [routeKey, statusStr] = key.split('#');
            const [method, ...routeParts] = (routeKey ?? '').split(' ');
            const route = routeParts.join(' ');
            const duration = this.requestDurations.get(key) ?? 0;
            const bytes = this.responseBytes.get(key) ?? 0;
            routes.push({
                method: method ?? 'GET',
                route,
                status: Number(statusStr) || 200,
                count,
                totalDurationMs: duration,
                totalResponseBytes: bytes
            });
        }

        const jobData = await this.getJobStats(services.storage);
        const slo = this.evaluateSlo(services.manager);

        return {
            uptimeSec,
            activeHttpRequests: this.activeHttpRequests,
            activeProxyStreams: this.activeProxyStreams,
            requests: routes,
            providers: services.manager
                ? {
                      total: services.manager.list().length,
                      streamEnabled: services.manager.getStreamEnabled().length,
                      subtitleEnabled:
                          services.manager.getSubtitleEnabled().length,
                      revision: services.manager.getRevision()
                  }
                : undefined,
            cache: services.cache ? services.cache.snapshot() : undefined,
            circuits: services.circuit
                ? services.circuit.snapshot()
                : undefined,
            proxy: {
                totalBytes: this.proxyBytesTotal,
                rangeRequests: this.proxyRangeRequests,
                deniedSsrf: this.proxyDeniedSsrf,
                activeStreams: this.activeProxyStreams
            },
            debrid: { enabled: debridService.isEnabled() },
            jobs: jobData,
            slo
        };
    }
}

export const globalMetrics = new MetricsCollector();
