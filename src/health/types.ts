/**
 * Health & Reliability Types for addons-core.
 * Phase 6.4: 3-tier health model (liveness, readiness, service status)
 * with provider freshness windows, degraded mode thresholds, and incident alarms.
 */

export type FailureClassification =
    | 'timeout'
    | 'network'
    | 'http_5xx'
    | 'http_4xx'
    | 'invalid_manifest'
    | 'ssl_error'
    | 'dns'
    | 'debrid_unavailable'
    | 'none';

export type CheckType = 'manifest' | 'stream_probe' | 'subtitle_probe';

export interface ProviderHealthRecord {
    healthy: boolean;
    lastChecked: string;
    checkType: CheckType;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    latencyMs: number;
    failureClassification: FailureClassification;
    freshnessWindowMs: number;
    isFresh: boolean;
    circuitState?: 'closed' | 'open' | 'half-open';
    error?: string;
}

export interface DependencyStatus {
    name: string;
    type: string;
    status: 'ok' | 'degraded' | 'down';
    latencyMs?: number;
    message?: string;
    details?: Record<string, unknown>;
}

export interface LivenessReport {
    status: 'ok';
    uptimeSec: number;
    timestamp: string;
    pid?: number;
    version?: string;
    eventLoopLagMs?: number;
    memory: {
        heapUsedMb: number;
        heapTotalMb: number;
        rssMb: number;
    };
}

export interface ReadinessReport {
    status: 'ok' | 'degraded' | 'down';
    ready: boolean;
    uptimeSec: number;
    timestamp: string;
    revision: number;
    checks: Record<
        string,
        { ok: boolean; message?: string; latencyMs?: number }
    >;
}

export interface ActiveIncident {
    code: string;
    severity: 'warning' | 'critical';
    message: string;
    detectedAt: string;
    runbook: string;
}

export interface ServiceStatusReport {
    status: 'ok' | 'degraded' | 'down';
    timestamp: string;
    uptimeSec: number;
    version: string;
    revision: number;
    providers: {
        total: number;
        streamEnabled: number;
        subtitleEnabled: number;
        healthyStream: number;
        usableRatio: number;
        staleCount: number;
    };
    details?: {
        streamProviders: {
            total: number;
            usable: number;
            usableRatio: number;
        };
    };
    degradedReasons: string[];
    activeIncidents: ActiveIncident[];
    incidents?: ActiveIncident[];
    dependencies: DependencyStatus[];
}
