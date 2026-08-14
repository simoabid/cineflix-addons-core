/**
 * Background health monitor + manifest auto-refresh + probe endpoints.
 * Phase 6.4: Redesigned 3-level health semantics (Liveness, Readiness, Service Status)
 * with provider freshness windows, degraded mode thresholds, and incident alarms.
 */
import type { AddonManager } from '../addons/manager.js';
import { fetchManifest } from '../stremio/client.js';
import type { JobEngine } from '../jobs/engine.js';
import type { IStorageBackend } from '../storage/types.js';
import type { CacheManager } from '../cache/manager.js';
import { debridService } from '../debrid/service.js';
import { globalReliability } from '../reliability/circuit.js';
import { logger } from '../telemetry/logger.js';
import type {
    FailureClassification,
    CheckType,
    DependencyStatus,
    LivenessReport,
    ReadinessReport,
    ServiceStatusReport,
    ActiveIncident
} from './types.js';

const CONCURRENCY = 4;

export interface HealthCheckSummary {
    checked: number;
    healthy: number;
    unhealthy: number;
    stale: number;
}

export class HealthMonitor {
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly bootTime = Date.now();
    private cachedTmdbResult?: {
        timestamp: number;
        key: string;
        item: DependencyStatus;
    };

    constructor(
        private readonly manager: AddonManager,
        private readonly opts: {
            intervalMinutes: number;
            autoRefresh: boolean;
            jobEngine?: JobEngine;
            staleThresholdMinutes?: number;
            degradedMinProvidersRatio?: number;
            version?: string;
        }
    ) {}

    /**
     * 1. Liveness Probe (GET /health/live)
     * Verifies that the Node.js process and event loop are responsive.
     */
    getLiveness(): LivenessReport {
        const mem = process.memoryUsage();
        return {
            status: 'ok',
            uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
            timestamp: new Date().toISOString(),
            pid: process.pid,
            version: this.opts.version ?? '1.0.0',
            memory: {
                heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
                rssMb: Math.round(mem.rss / 1024 / 1024)
            }
        };
    }

    /**
     * 2. Readiness Probe (GET /health/ready)
     * Verifies that all required local and shared infrastructure components
     * (storage, cache, manager, job engine) are ready to accept inbound traffic.
     */
    async getReadiness(services?: {
        storage?: IStorageBackend;
        cache?: CacheManager;
        jobEngine?: JobEngine;
    }): Promise<ReadinessReport> {
        const checks: Record<
            string,
            { ok: boolean; message?: string; latencyMs?: number }
        > = {};
        let allOk = true;

        // 1. Manager state
        try {
            const list = this.manager.list();
            checks.manager = {
                ok: true,
                message: `Active (${list.length} installed, ${this.manager.getStreamEnabled().length} stream-ready)`
            };
        } catch (err) {
            allOk = false;
            checks.manager = {
                ok: false,
                message:
                    err instanceof Error ? err.message : 'Manager unavailable'
            };
        }

        // 2. Storage backend
        if (services?.storage) {
            const t0 = Date.now();
            try {
                const storageAny = services.storage as unknown as {
                    listAddons?: () => Promise<unknown>;
                    readAddons?: () => Promise<unknown>;
                };
                if (typeof storageAny.listAddons === 'function') {
                    await storageAny.listAddons();
                } else if (typeof storageAny.readAddons === 'function') {
                    await storageAny.readAddons();
                }
                const latencyMs = Date.now() - t0;
                const desc =
                    typeof services.storage.describe === 'function'
                        ? services.storage.describe()
                        : 'Storage';
                checks.storage = {
                    ok: true,
                    latencyMs,
                    message: `${desc} responsive (${latencyMs}ms)`
                };
            } catch (err) {
                allOk = false;
                checks.storage = {
                    ok: false,
                    latencyMs: Date.now() - t0,
                    message:
                        err instanceof Error
                            ? err.message
                            : 'Storage read error'
                };
            }
        }

        // 3. Cache manager
        if (services?.cache) {
            try {
                const snap = services.cache.snapshot();
                checks.cache = {
                    ok: true,
                    message: `Backend: ${snap.backend} (cardinality: ${snap.cardinality})`
                };
            } catch (err) {
                allOk = false;
                checks.cache = {
                    ok: false,
                    message: err instanceof Error ? err.message : 'Cache error'
                };
            }
        }

        // 4. Job engine
        if (services?.jobEngine) {
            try {
                const stats = services.jobEngine.getStats();
                checks.jobs = {
                    ok: true,
                    message: `Workers: ${stats.workers}, active: ${stats.activeJobs}`
                };
            } catch (err) {
                allOk = false;
                checks.jobs = {
                    ok: false,
                    message:
                        err instanceof Error ? err.message : 'Job engine error'
                };
            }
        }

        const isStorageDown = checks.storage && !checks.storage.ok;
        const isManagerDown = checks.manager && !checks.manager.ok;
        const status: 'ok' | 'degraded' | 'down' = allOk
            ? 'ok'
            : isStorageDown || isManagerDown
              ? 'down'
              : 'degraded';

        return {
            status,
            ready: allOk,
            uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
            timestamp: new Date().toISOString(),
            revision: this.manager.getRevision(),
            checks
        };
    }

    /**
     * 3. Comprehensive Service Status (GET /health/status & GET /health)
     * Evaluates provider freshness, degraded modes, active incident conditions,
     * and external dependencies.
     */
    async getServiceStatus(services?: {
        storage?: IStorageBackend;
        cache?: CacheManager;
        jobEngine?: JobEngine;
        tmdbKey?: string;
    }): Promise<ServiceStatusReport> {
        const list = this.manager.list();
        const streamEnabled = this.manager.getStreamEnabled();
        const subtitleEnabled = this.manager.getSubtitleEnabled();
        const now = Date.now();
        const staleThresholdMs =
            (this.opts.staleThresholdMinutes ?? 60) * 60 * 1000;
        const degradedMinRatio = this.opts.degradedMinProvidersRatio ?? 0.5;

        let healthyStream = 0;
        let staleCount = 0;

        for (const addon of list) {
            if (addon.enabled) {
                const lastCheck = addon.health?.lastChecked
                    ? new Date(addon.health.lastChecked).getTime()
                    : 0;
                if (!lastCheck || now - lastCheck > staleThresholdMs) {
                    staleCount++;
                }
            }
        }

        for (const addon of streamEnabled) {
            const h = addon.health as unknown as
                | { healthy?: boolean; status?: string; circuitState?: string }
                | undefined;
            const isCircuitOpen =
                globalReliability.getState(addon.providerId) === 'open' ||
                h?.circuitState === 'open';
            const isHealthy =
                !isCircuitOpen &&
                (h?.healthy === true ||
                    h?.status === 'healthy' ||
                    (h?.healthy !== false &&
                        h?.status !== 'down' &&
                        h?.status !== 'unhealthy'));
            if (isHealthy) {
                healthyStream++;
            }
        }

        const usableRatio =
            streamEnabled.length > 0
                ? Number((healthyStream / streamEnabled.length).toFixed(2))
                : 1.0;

        const degradedReasons: string[] = [];
        const activeIncidents: ActiveIncident[] = [];

        // Check if stream provider availability is below threshold
        if (streamEnabled.length > 0 && healthyStream === 0) {
            degradedReasons.push('No healthy stream providers available');
            activeIncidents.push({
                code: 'ALL_STREAM_PROVIDERS_DOWN',
                severity: 'critical',
                message:
                    'All configured stream providers are currently unhealthy or circuit-broken',
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/provider-failing.md'
            });
            activeIncidents.push({
                code: 'PROVIDERS_DEGRADED',
                severity: 'critical',
                message: 'All configured stream providers are currently down',
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/provider-failing.md'
            });
        } else if (streamEnabled.length > 0 && usableRatio < degradedMinRatio) {
            degradedReasons.push(
                `Healthy stream providers ratio (${usableRatio}) is below configured threshold (${degradedMinRatio})`
            );
            activeIncidents.push({
                code: 'PROVIDERS_DEGRADED',
                severity: 'warning',
                message: `Stream provider pool degraded: only ${healthyStream}/${streamEnabled.length} usable`,
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/provider-failing.md'
            });
            activeIncidents.push({
                code: 'HIGH_PROVIDER_FAILURE_RATE',
                severity: 'warning',
                message: `Stream provider pool degraded: only ${healthyStream}/${streamEnabled.length} usable`,
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/provider-failing.md'
            });
        }

        // Stale checks warning
        if (staleCount > 0) {
            degradedReasons.push(
                `Enabled providers have stale health checks (> ${this.opts.staleThresholdMinutes ?? 60}m)`
            );
            activeIncidents.push({
                code: 'STALE_PROVIDER_HEALTH',
                severity: 'warning',
                message: `${staleCount} enabled providers have stale health checks`,
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/stuck-jobs.md'
            });
            activeIncidents.push({
                code: 'STALE_HEALTH_CHECKS',
                severity: 'warning',
                message:
                    'Provider health sweeps are not running or failing to execute',
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/stuck-jobs.md'
            });
        }

        // Dependencies assessment
        const depReport = await this.getDependencies(services);
        const hasDownDep = depReport.dependencies.some(
            (d) => d.status === 'down'
        );
        const hasDegradedDep = depReport.dependencies.some(
            (d) => d.status === 'degraded'
        );

        if (hasDownDep) {
            degradedReasons.push('One or more critical dependencies are down');
            activeIncidents.push({
                code: 'CRITICAL_DEPENDENCY_DOWN',
                severity: 'critical',
                message:
                    'A core storage or infrastructure dependency is unreachable',
                detectedAt: new Date().toISOString(),
                runbook: '/docs/runbooks/storage-cache-outage.md'
            });
        }

        const overallStatus: 'ok' | 'degraded' | 'down' = hasDownDep
            ? 'down'
            : degradedReasons.length > 0 || hasDegradedDep
              ? 'degraded'
              : 'ok';

        return {
            status: overallStatus,
            timestamp: new Date().toISOString(),
            uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
            version: this.opts.version ?? '1.0.0',
            revision: this.manager.getRevision(),
            providers: {
                total: list.length,
                streamEnabled: streamEnabled.length,
                subtitleEnabled: subtitleEnabled.length,
                healthyStream,
                usableRatio,
                staleCount
            },
            details: {
                streamProviders: {
                    total: streamEnabled.length,
                    usable: healthyStream,
                    usableRatio
                }
            },
            degradedReasons,
            activeIncidents,
            incidents: activeIncidents,
            dependencies: depReport.dependencies
        };
    }

    /** Detailed dependency status for external and internal infrastructure. */
    async getDependencies(services?: {
        storage?: IStorageBackend;
        cache?: CacheManager;
        jobEngine?: JobEngine;
        tmdbKey?: string;
    }): Promise<{
        status: 'ok' | 'degraded' | 'down';
        dependencies: DependencyStatus[];
    }> {
        const deps: DependencyStatus[] = [];

        // Storage
        if (services?.storage) {
            const t0 = Date.now();
            try {
                await services.storage.listAddons();
                deps.push({
                    name: 'Storage',
                    type:
                        services.storage.describe().split(':')[0] || 'storage',
                    status: 'ok',
                    latencyMs: Date.now() - t0,
                    details: { description: services.storage.describe() }
                });
            } catch (err) {
                deps.push({
                    name: 'Storage',
                    type: 'storage',
                    status: 'down',
                    latencyMs: Date.now() - t0,
                    message:
                        err instanceof Error
                            ? err.message
                            : 'Storage unreachable'
                });
            }
        }

        // Cache
        if (services?.cache) {
            const snap = services.cache.snapshot();
            deps.push({
                name: 'Cache',
                type: snap.backend,
                status: 'ok',
                details: {
                    hits: snap.hits,
                    misses: snap.misses,
                    swrHits: snap.swrHits,
                    cardinality: snap.cardinality
                }
            });
        }

        // TMDB
        if (services?.tmdbKey) {
            const now = Date.now();
            if (
                this.cachedTmdbResult &&
                this.cachedTmdbResult.key === services.tmdbKey &&
                now - this.cachedTmdbResult.timestamp < 60_000
            ) {
                deps.push({ ...this.cachedTmdbResult.item });
            } else {
                const t0 = Date.now();
                let item: DependencyStatus;
                try {
                    const res = await fetch(
                        `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(services.tmdbKey)}`,
                        { signal: AbortSignal.timeout(3000) }
                    );
                    const latencyMs = Date.now() - t0;
                    if (res.ok) {
                        item = {
                            name: 'TMDB',
                            type: 'upstream_api',
                            status: 'ok',
                            latencyMs,
                            details: { configured: true }
                        };
                    } else if (res.status === 401 || res.status === 403) {
                        item = {
                            name: 'TMDB',
                            type: 'upstream_api',
                            status: 'degraded',
                            latencyMs,
                            message: `Invalid API key (HTTP ${res.status})`
                        };
                    } else {
                        item = {
                            name: 'TMDB',
                            type: 'upstream_api',
                            status: 'degraded',
                            latencyMs,
                            message: `Unexpected status: ${res.status}`
                        };
                    }
                } catch (err) {
                    item = {
                        name: 'TMDB',
                        type: 'upstream_api',
                        status: 'degraded',
                        latencyMs: Date.now() - t0,
                        message:
                            err instanceof Error
                                ? err.message
                                : 'TMDB unreachable'
                    };
                }
                this.cachedTmdbResult = {
                    timestamp: now,
                    key: services.tmdbKey,
                    item
                };
                deps.push(item);
            }
        } else {
            deps.push({
                name: 'TMDB',
                type: 'upstream_api',
                status: 'degraded',
                message: 'API Key missing'
            });
        }

        // Debrid
        if (debridService.isEnabled()) {
            const debStatus = debridService.status();
            deps.push({
                name: 'Debrid',
                type: 'debrid_service',
                status: 'ok',
                details: {
                    provider: debStatus.provider,
                    cachedLinks: debStatus.cachedLinksCount
                }
            });
        }

        // Job Engine
        if (services?.jobEngine) {
            const stats = services.jobEngine.getStats();
            deps.push({
                name: 'JobEngine',
                type: 'worker_pool',
                status: 'ok',
                details: {
                    workers: stats.workers,
                    active: stats.activeJobs
                }
            });
        }

        const hasDown = deps.some((d) => d.status === 'down');
        const hasDegraded = deps.some((d) => d.status === 'degraded');
        const overallStatus = hasDown
            ? 'down'
            : hasDegraded
              ? 'degraded'
              : 'ok';

        return {
            status: overallStatus,
            dependencies: deps
        };
    }

    private classifyProbeError(err: unknown): FailureClassification {
        if (!err || typeof err !== 'object') return 'none';
        const msg = (err as Error).message?.toLowerCase() ?? '';
        const name = (err as Error).name ?? '';
        if (
            name === 'TimeoutError' ||
            msg.includes('timeout') ||
            msg.includes('timed out')
        ) {
            return 'timeout';
        }
        if (
            msg.includes('dns') ||
            msg.includes('enotfound') ||
            msg.includes('eai_again')
        ) {
            return 'dns';
        }
        if (
            msg.includes('ssl') ||
            msg.includes('tls') ||
            msg.includes('certificate')
        ) {
            return 'ssl_error';
        }
        if (msg.includes('404') || msg.includes('401') || msg.includes('403')) {
            return 'http_4xx';
        }
        if (
            msg.includes('500') ||
            msg.includes('502') ||
            msg.includes('503') ||
            msg.includes('504')
        ) {
            return 'http_5xx';
        }
        if (
            msg.includes('manifest') ||
            msg.includes('json') ||
            msg.includes('syntax')
        ) {
            return 'invalid_manifest';
        }
        return 'network';
    }

    /** Run a single sweep over all stream-enabled addons. */
    async checkAll(): Promise<HealthCheckSummary & { revision: number }> {
        const addons = this.manager.getStreamEnabled();
        let healthy = 0;
        let stale = 0;
        const now = Date.now();
        const staleThresholdMs =
            (this.opts.staleThresholdMinutes ?? 60) * 60 * 1000;

        for (let i = 0; i < addons.length; i += CONCURRENCY) {
            const batch = addons.slice(i, i + CONCURRENCY);
            const results = await Promise.all(
                batch.map((a) => this.checkOne(a.providerId, a.manifestUrl))
            );
            healthy += results.filter(Boolean).length;
        }

        for (const a of addons) {
            const last = a.health?.lastChecked
                ? new Date(a.health.lastChecked).getTime()
                : 0;
            if (!last || now - last > staleThresholdMs) {
                stale++;
            }
        }

        return {
            checked: addons.length,
            healthy,
            unhealthy: addons.length - healthy,
            stale,
            revision: this.manager.getRevision()
        };
    }

    private async checkOne(
        providerId: string,
        manifestUrl: string,
        checkType: CheckType = 'manifest'
    ): Promise<boolean> {
        const t0 = Date.now();
        try {
            if (this.opts.autoRefresh) {
                const r = await this.manager.refresh(providerId);
                const latencyMs = Date.now() - t0;
                this.manager.setHealth(providerId, r.ok, {
                    checkType,
                    latencyMs,
                    failureClassification: r.ok
                        ? 'none'
                        : this.classifyProbeError(r.error),
                    circuitState: globalReliability.getState(providerId),
                    error: r.ok ? undefined : r.error
                });
                return r.ok;
            }
            await fetchManifest(manifestUrl, 8000);
            const latencyMs = Date.now() - t0;
            this.manager.setHealth(providerId, true, {
                checkType,
                latencyMs,
                failureClassification: 'none',
                circuitState: globalReliability.getState(providerId)
            });
            return true;
        } catch (err) {
            const latencyMs = Date.now() - t0;
            const failureClassification = this.classifyProbeError(err);
            const errorMsg =
                err instanceof Error ? err.message : 'health check failed';
            this.manager.setHealth(providerId, false, {
                checkType,
                latencyMs,
                failureClassification,
                circuitState: globalReliability.getState(providerId),
                error: errorMsg
            });
            return false;
        }
    }

    /** Trigger a sweep via the JobEngine if available, otherwise in-process. */
    async triggerSweep(): Promise<{ queued: boolean; jobId?: string }> {
        if (this.opts.jobEngine) {
            try {
                const job = await this.opts.jobEngine.enqueue(
                    'health-sweep',
                    {},
                    { dedupKey: 'health-sweep-scheduled' }
                );
                return { queued: true, jobId: job.id };
            } catch {
                /* fall back to direct check */
            }
        }
        await this.checkAll();
        return { queued: false };
    }

    /** Start the periodic sweep (no-op when interval <= 0). */
    start(): void {
        const minutes = this.opts.intervalMinutes;
        if (!minutes || minutes <= 0) {
            logger.info('Health periodic checks disabled (interval <= 0)', {
                component: 'health'
            });
            return;
        }
        const ms = minutes * 60 * 1000;
        setTimeout(() => void this.triggerSweep(), 5000);
        this.timer = setInterval(() => void this.triggerSweep(), ms);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        logger.info(
            `Health monitoring started every ${minutes}m (auto-refresh: ${this.opts.autoRefresh})`,
            { component: 'health', intervalMinutes: minutes }
        );
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
