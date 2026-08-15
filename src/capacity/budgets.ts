/**
 * Capacity & cost controls (Phase 7 §10.4).
 *
 * - ProviderBudgetRegistry: per-provider daily upstream-call budgets with
 *   optional per-provider overrides. When a budget is exhausted the provider
 *   is skipped by selection and surfaces a diagnostic instead of hammering a
 *   fragile upstream. Counters are per-instance (best-effort); deployments
 *   that need exact global accounting can scale limits by replica count.
 *
 * - EgressBudgetMonitor: daily egress (and residential-proxy) byte budgets
 *   with threshold alerts surfaced through /health/status incidents and
 *   structured logs, so cost surprises are detected before the invoice.
 */

import { logger } from '../telemetry/logger.js';
import { globalMetrics } from '../metrics/index.js';
import type { AppConfig } from '../config.js';

function utcDayKey(now = new Date()): string {
    return now.toISOString().slice(0, 10);
}

function nextUtcMidnightMs(now = new Date()): number {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return next.getTime();
}

export interface BudgetConsumeResult {
    allowed: boolean;
    used: number;
    limit: number;
    /** Epoch ms when the budget window resets (null when unlimited). */
    resetAt: number | null;
}

export interface ProviderBudgetOptions {
    /** Default daily limit for every provider; 0 = unlimited. */
    defaultDailyLimit: number;
    /** Per-provider overrides, e.g. { 'addon:fragile': 500 }. */
    overrides?: Record<string, number>;
}

export class ProviderBudgetRegistry {
    private readonly counters = new Map<
        string,
        { day: string; count: number }
    >();
    private defaultDailyLimit: number;
    private overrides: Record<string, number>;
    private readonly exhausted = new Set<string>();

    constructor(opts: ProviderBudgetOptions) {
        this.defaultDailyLimit = Math.max(
            0,
            Math.floor(opts.defaultDailyLimit)
        );
        this.overrides = opts.overrides ?? {};
    }

    /** Update limits at boot (server.ts). Does not reset running counters. */
    configure(opts: ProviderBudgetOptions): void {
        if (opts.defaultDailyLimit !== undefined) {
            this.defaultDailyLimit = Math.max(
                0,
                Math.floor(opts.defaultDailyLimit)
            );
        }
        if (opts.overrides !== undefined) {
            this.overrides = opts.overrides;
        }
    }

    private limitFor(providerId: string): number {
        const override = this.overrides[providerId];
        if (typeof override === 'number' && override > 0) return override;
        return this.defaultDailyLimit;
    }

    /**
     * Consume one unit of the provider's daily budget before an upstream
     * call. Idempotent-safe to call once per attempted provider request.
     */
    consume(providerId: string): BudgetConsumeResult {
        const limit = this.limitFor(providerId);
        if (limit <= 0) {
            return { allowed: true, used: 0, limit: 0, resetAt: null };
        }
        const day = utcDayKey();
        let rec = this.counters.get(providerId);
        if (!rec || rec.day !== day) {
            rec = { day, count: 0 };
            this.counters.set(providerId, rec);
            this.exhausted.delete(providerId);
        }
        // Check before incrementing so isExhausted (>=limit) and consume
        // agree on the boundary: the limit-th call is still allowed, the
        // limit+1 call is the first rejection.
        if (rec.count >= limit) {
            if (!this.exhausted.has(providerId)) {
                this.exhausted.add(providerId);
                globalMetrics.recordProviderBudgetExhausted(providerId);
                logger.warn(
                    `Provider daily call budget exhausted: ${providerId} (${limit}/day) — provider will be skipped until ${new Date(nextUtcMidnightMs()).toISOString()}`,
                    { component: 'capacity', providerId, limit }
                );
            }
            return {
                allowed: false,
                used: rec.count,
                limit,
                resetAt: nextUtcMidnightMs()
            };
        }
        rec.count += 1;
        return {
            allowed: true,
            used: rec.count,
            limit,
            resetAt: nextUtcMidnightMs()
        };
    }

    isExhausted(providerId: string): boolean {
        const limit = this.limitFor(providerId);
        if (limit <= 0) return false;
        const rec = this.counters.get(providerId);
        if (!rec || rec.day !== utcDayKey()) return false;
        return rec.count >= limit;
    }

    /** Manual reset (admin action / tests). */
    reset(providerId?: string): void {
        if (providerId) {
            this.counters.delete(providerId);
            this.exhausted.delete(providerId);
        } else {
            this.counters.clear();
            this.exhausted.clear();
        }
    }

    snapshot(): Record<
        string,
        { used: number; limit: number; exhausted: boolean }
    > {
        const out: Record<
            string,
            { used: number; limit: number; exhausted: boolean }
        > = {};
        for (const [providerId, rec] of this.counters) {
            out[providerId] = {
                used: rec.count,
                limit: this.limitFor(providerId),
                exhausted: this.isExhausted(providerId)
            };
        }
        return out;
    }
}

export type EgressBudgetLevel = 'ok' | 'warning' | 'exceeded';

/** Process-wide budget registry, configured from AppConfig at boot. */
export const globalProviderBudgets = new ProviderBudgetRegistry({
    defaultDailyLimit: 0
});

/** Configure budget registries from AppConfig (server.ts calls this at boot). */
export function configureCapacityFromConfig(cfg: AppConfig): {
    providerBudgets: ProviderBudgetRegistry;
} {
    globalProviderBudgets.configure({
        defaultDailyLimit: cfg.providerDailyCallBudget,
        overrides: cfg.providerBudgetOverrides
    });
    return { providerBudgets: globalProviderBudgets };
}

export interface EgressBudgetState {
    level: EgressBudgetLevel;
    dailyBytes: number;
    proxyBytes: number;
    dailyBudgetBytes: number;
    proxyBudgetBytes: number;
    usedPct: number;
    proxyUsedPct: number;
    resetsAt: string;
}

export interface EgressBudgetOptions {
    /** Total daily egress budget in bytes; 0 = disabled. */
    dailyBudgetBytes: number;
    /** Residential-proxy egress budget in bytes; 0 = disabled. */
    proxyBudgetBytes: number;
    /** Warn threshold fraction (default 0.75). */
    warnAt?: number;
}

/**
 * Tracks egress bytes against daily budgets and raises alerts (structured
 * warn logs + health incidents) at configured thresholds. Per-instance
 * accounting; each replica should be provisioned a share of the real budget.
 */
export class EgressBudgetMonitor {
    private day = utcDayKey();
    private dailyBytes = 0;
    private proxyBytes = 0;
    private lastLevel: EgressBudgetLevel = 'ok';
    private lastProxyLevel: EgressBudgetLevel = 'ok';

    constructor(private readonly opts: EgressBudgetOptions) {}

    private rollDayIfNeeded(): void {
        const today = utcDayKey();
        if (today !== this.day) {
            this.day = today;
            this.dailyBytes = 0;
            this.proxyBytes = 0;
            this.lastLevel = 'ok';
            this.lastProxyLevel = 'ok';
        }
    }

    /** Record completed egress; `proxied` marks metered residential-proxy bytes. */
    record(bytes: number, proxied = false): void {
        if (bytes <= 0) return;
        this.rollDayIfNeeded();
        this.dailyBytes += bytes;
        if (proxied) this.proxyBytes += bytes;
        this.evaluateLevels();
    }

    private evaluateLevels(): void {
        const { dailyBudgetBytes, proxyBudgetBytes } = this.opts;
        if (dailyBudgetBytes > 0) {
            const level: EgressBudgetLevel =
                this.dailyBytes >= dailyBudgetBytes
                    ? 'exceeded'
                    : this.dailyBytes >=
                        dailyBudgetBytes * (this.opts.warnAt ?? 0.75)
                      ? 'warning'
                      : 'ok';
            if (level !== this.lastLevel) {
                this.lastLevel = level;
                const msg =
                    `Egress budget ${level}: ${(this.dailyBytes / 1e6).toFixed(1)}MB ` +
                    `of ${(dailyBudgetBytes / 1e6).toFixed(0)}MB daily budget used`;
                if (level === 'exceeded') {
                    logger.error(`EGRESS_BUDGET_EXCEEDED — ${msg}`, {
                        component: 'capacity',
                        dailyBytes: this.dailyBytes,
                        budgetBytes: dailyBudgetBytes
                    });
                } else {
                    logger.warn(msg, {
                        component: 'capacity',
                        dailyBytes: this.dailyBytes,
                        budgetBytes: dailyBudgetBytes
                    });
                }
            }
        }
        if (proxyBudgetBytes > 0) {
            const level: EgressBudgetLevel =
                this.proxyBytes >= proxyBudgetBytes
                    ? 'exceeded'
                    : this.proxyBytes >=
                        proxyBudgetBytes * (this.opts.warnAt ?? 0.75)
                      ? 'warning'
                      : 'ok';
            if (level !== this.lastProxyLevel) {
                this.lastProxyLevel = level;
                const msg =
                    `Residential-proxy budget ${level}: ${(this.proxyBytes / 1e6).toFixed(1)}MB ` +
                    `of ${(proxyBudgetBytes / 1e6).toFixed(0)}MB daily budget used`;
                if (level === 'exceeded') {
                    logger.error(`PROXY_BUDGET_EXCEEDED — ${msg}`, {
                        component: 'capacity',
                        proxyBytes: this.proxyBytes,
                        budgetBytes: proxyBudgetBytes
                    });
                } else {
                    logger.warn(msg, {
                        component: 'capacity',
                        proxyBytes: this.proxyBytes,
                        budgetBytes: proxyBudgetBytes
                    });
                }
            }
        }
    }

    state(): EgressBudgetState {
        this.rollDayIfNeeded();
        const { dailyBudgetBytes, proxyBudgetBytes } = this.opts;
        return {
            level: this.lastLevel,
            dailyBytes: this.dailyBytes,
            proxyBytes: this.proxyBytes,
            dailyBudgetBytes,
            proxyBudgetBytes,
            usedPct:
                dailyBudgetBytes > 0
                    ? Number(
                          ((this.dailyBytes / dailyBudgetBytes) * 100).toFixed(
                              2
                          )
                      )
                    : 0,
            proxyUsedPct:
                proxyBudgetBytes > 0
                    ? Number(
                          ((this.proxyBytes / proxyBudgetBytes) * 100).toFixed(
                              2
                          )
                      )
                    : 0,
            resetsAt: new Date(nextUtcMidnightMs()).toISOString()
        };
    }
}
