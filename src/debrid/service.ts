/**
 * Debrid service singleton.
 *
 * Holds the active resolver + a short-TTL cache of resolved links, and is shared
 * by every StremioAddonProvider so torrent streams become playable HTTP sources.
 * Reconfigured at runtime when the admin updates debrid settings.
 *
 * Phase 4 enhancements: typed resolutions, capability contracts, link expiry,
 * telemetry/error classification, and audit hooks.
 */
import { RealDebridResolver } from './realdebrid.js';
import { AllDebridResolver } from './alldebrid.js';
import { PremiumizeResolver } from './premiumize.js';
import type {
    DebridConfig,
    DebridProviderId,
    DebridResolver,
    DebridResolution,
    DebridCapabilities,
    DebridCheckResult,
    FileSelectionResult,
    ResolveInput
} from './types.js';
import type { AuditLogger } from '../security/audit.js';
import { globalMetrics } from '../metrics/index.js';
import { tracer } from '../telemetry/tracing.js';
import { globalConcurrency } from '../concurrency/coordinator.js';

interface CacheEntry {
    url: string;
    selectedFile: FileSelectionResult;
    expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — debrid links stay valid a while.
const CACHE_MAX = 500;

class DebridService {
    private resolver: DebridResolver | null = null;
    private config: DebridConfig = {
        provider: 'none',
        apiKey: '',
        source: 'none'
    };
    private cache = new Map<string, CacheEntry>();
    private auditLogger?: AuditLogger;

    private authFailureTimestamps: number[] = [];
    private static readonly AUTH_FAILURE_ALERT_THRESHOLD = 3;
    private static readonly AUTH_FAILURE_ALERT_WINDOW_MS = 15 * 60 * 1000; // 15 mins

    setAuditLogger(logger: AuditLogger): void {
        this.auditLogger = logger;
    }

    configure(config: DebridConfig): void {
        this.config = { ...config };
        this.clearCache();
        this.authFailureTimestamps = [];
        this.resolver = createResolver(config);
    }

    isEnabled(): boolean {
        return this.resolver !== null;
    }

    getResolver(): DebridResolver | null {
        return this.resolver;
    }

    getCapabilities(): DebridCapabilities | null {
        return this.resolver ? this.resolver.getCapabilities() : null;
    }

    clearCache(): void {
        this.cache.clear();
    }

    private handleAuthFailure(
        reason: string,
        meta?: Record<string, unknown>
    ): void {
        const now = Date.now();
        this.authFailureTimestamps.push(now);
        const cutoff = now - DebridService.AUTH_FAILURE_ALERT_WINDOW_MS;
        this.authFailureTimestamps = this.authFailureTimestamps.filter(
            (t) => t >= cutoff
        );

        const count = this.authFailureTimestamps.length;
        const isAlert = count >= DebridService.AUTH_FAILURE_ALERT_THRESHOLD;

        if (isAlert) {
            console.error(
                `\n🚨 [ALERT] DEBRID_AUTH_FAILURE: Debrid provider '${this.config.provider}' has failed authentication ${count} times in the last 15 minutes! Please check API credentials.\n`
            );
        }

        if (this.auditLogger) {
            void this.auditLogger.record({
                actor: { id: 'system', role: 'admin', method: 'static-token' },
                action: isAlert
                    ? 'alert.debrid_auth_failure'
                    : 'debrid.auth_failure',
                outcome: 'failure',
                reason,
                meta: {
                    provider: this.config.provider,
                    failuresInWindow: count,
                    threshold: DebridService.AUTH_FAILURE_ALERT_THRESHOLD,
                    alert: isAlert,
                    ...meta
                }
            });
        }
    }

    /** Safe status (never leaks the API key). */
    status(): {
        provider: DebridProviderId;
        enabled: boolean;
        hasKey: boolean;
        source: string;
        capabilities: DebridCapabilities | null;
        cachedLinksCount: number;
        activeAlerts: Array<{
            code: string;
            message: string;
            failuresInWindow: number;
        }>;
    } {
        const now = Date.now();
        const cutoff = now - DebridService.AUTH_FAILURE_ALERT_WINDOW_MS;
        const recentFailures = this.authFailureTimestamps.filter(
            (t) => t >= cutoff
        ).length;
        const activeAlerts =
            recentFailures >= DebridService.AUTH_FAILURE_ALERT_THRESHOLD
                ? [
                      {
                          code: 'DEBRID_AUTH_FAILURE',
                          message: `Debrid provider '${this.config.provider}' has failed authentication ${recentFailures} times in the last 15 minutes.`,
                          failuresInWindow: recentFailures
                      }
                  ]
                : [];

        return {
            provider: this.config.provider,
            enabled: this.isEnabled(),
            hasKey: Boolean(this.config.apiKey),
            source: this.config.source ?? 'none',
            capabilities: this.getCapabilities(),
            cachedLinksCount: this.cache.size,
            activeAlerts
        };
    }

    async checkCredentials(): Promise<DebridCheckResult> {
        if (!this.resolver) {
            return {
                ok: false,
                error: 'No debrid provider configured',
                errorKind: 'unsupported'
            };
        }
        const res = await this.resolver.checkCredentials();
        if (res.ok) {
            this.authFailureTimestamps = [];
        } else if (res.errorKind === 'auth_failure') {
            this.handleAuthFailure(res.error || 'Check failed', {
                action: 'check'
            });
        }
        return res;
    }

    async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
        const res = await this.checkCredentials();
        return { ok: res.ok, user: res.user, error: res.error };
    }

    async resolveCached(input: ResolveInput): Promise<DebridResolution> {
        return tracer.withSpan(
            'debrid.resolve',
            async (span) => {
                span.setAttribute('debrid.provider', this.config.provider);
                if (!this.resolver) {
                    return {
                        kind: 'provider-error',
                        code: 'DEBRID_DISABLED',
                        errorKind: 'unsupported',
                        retryable: false,
                        safeMessage:
                            'Debrid service is disabled or not configured'
                    };
                }

                const key = this.cacheKey(input);
                const hit = this.cache.get(key);
                if (hit && hit.expiresAt > Date.now()) {
                    span.setAttribute('debrid.cached', true);
                    return {
                        kind: 'resolved',
                        url: hit.url,
                        selectedFile: hit.selectedFile,
                        cached: true,
                        expiresAt: new Date(hit.expiresAt)
                    };
                }
                span.setAttribute('debrid.cached', false);

                const t0 = Date.now();
                // Phase 7 §10.1 — debrid API calls draw from their own pool so
                // a burst of torrent resolutions can't saturate shared egress.
                const resolver = this.resolver;
                const resolution = await globalConcurrency.withSlot(
                    'debrid',
                    () => resolver.resolveCached(input)
                );
                const durationMs = Date.now() - t0;
                span.setAttribute('debrid.kind', resolution.kind);

                if (resolution.kind === 'resolved') {
                    this.authFailureTimestamps = [];
                    this.setCache(key, resolution.url, resolution.selectedFile);
                    globalMetrics.recordDebridResolution(
                        this.config.provider,
                        'cached',
                        durationMs
                    );
                } else if (resolution.kind === 'uncached') {
                    globalMetrics.recordDebridResolution(
                        this.config.provider,
                        'transferred',
                        durationMs
                    );
                } else if (resolution.kind === 'invalid-torrent') {
                    globalMetrics.recordDebridResolution(
                        this.config.provider,
                        'failed',
                        durationMs
                    );
                    globalMetrics.recordDebridError(
                        this.config.provider,
                        'INVALID_TORRENT'
                    );
                } else if (
                    resolution.kind === 'provider-error' &&
                    resolution.errorKind === 'auth_failure'
                ) {
                    globalMetrics.recordDebridResolution(
                        this.config.provider,
                        'failed',
                        durationMs
                    );
                    globalMetrics.recordDebridError(
                        this.config.provider,
                        'AUTH_FAILURE'
                    );
                    this.handleAuthFailure(resolution.safeMessage, {
                        infoHash: input.infoHash
                    });
                } else if (resolution.kind === 'provider-error') {
                    globalMetrics.recordDebridResolution(
                        this.config.provider,
                        'failed',
                        durationMs
                    );
                    globalMetrics.recordDebridError(
                        this.config.provider,
                        resolution.code || 'PROVIDER_ERROR'
                    );
                }

                return resolution;
            },
            {
                attributes: {
                    'debrid.provider': this.config.provider
                }
            }
        );
    }

    async pollTransferStatus(
        torrentId: string,
        opts?: {
            fileIdx?: number;
            season?: number;
            episode?: number;
            title?: string;
        }
    ): Promise<DebridResolution> {
        if (!this.resolver) {
            return {
                kind: 'provider-error',
                code: 'DEBRID_DISABLED',
                errorKind: 'unsupported',
                retryable: false,
                safeMessage: 'Debrid service is disabled'
            };
        }
        if (typeof this.resolver.pollTransferStatus === 'function') {
            return this.resolver.pollTransferStatus(torrentId, opts);
        }
        return {
            kind: 'provider-error',
            code: 'UNSUPPORTED_POLL',
            errorKind: 'unsupported',
            retryable: false,
            safeMessage: 'Provider does not support direct transfer polling'
        };
    }

    async cleanup(torrentId: string): Promise<void> {
        if (!this.resolver || !torrentId) return;
        try {
            await this.resolver.cleanup(torrentId);
        } catch {
            /* ignore best-effort cleanup error */
        }
    }

    async resolve(input: ResolveInput): Promise<string | null> {
        const res = await this.resolveCached(input);
        if (res.kind === 'resolved') return res.url;
        return null;
    }

    private cacheKey(input: ResolveInput): string {
        const variant =
            input.fileIdx != null
                ? `f${input.fileIdx}`
                : input.season != null
                  ? `s${input.season}e${input.episode}`
                  : 'm';
        return `${this.config.provider}:${input.infoHash.toLowerCase()}:${variant}`;
    }

    private setCache(
        key: string,
        url: string,
        selectedFile: FileSelectionResult
    ): void {
        if (this.cache.size >= CACHE_MAX) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }
        this.cache.set(key, {
            url,
            selectedFile,
            expiresAt: Date.now() + CACHE_TTL_MS
        });
    }
}

export function createResolver(config: DebridConfig): DebridResolver | null {
    if (!config.apiKey || config.provider === 'none') return null;
    switch (config.provider) {
        case 'realdebrid':
            return new RealDebridResolver(config.apiKey);
        case 'alldebrid':
            return new AllDebridResolver(config.apiKey);
        case 'premiumize':
            return new PremiumizeResolver(config.apiKey);
        default:
            return null;
    }
}

/** Process-wide shared instance. */
export const debridService = new DebridService();
