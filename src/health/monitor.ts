/**
 * Background health monitor + optional manifest auto-refresh.
 *
 * Periodically pings each enabled addon's manifest and records health on the
 * addon record (surfaced via /v1/addons + the admin UI). When ADDON_AUTO_REFRESH
 * is on, it also re-fetches the manifest (picking up new resources/types).
 */
import type { AddonManager } from '../addons/manager.js';
import { fetchManifest } from '../stremio/client.js';

const CONCURRENCY = 4;

export interface HealthCheckSummary {
    checked: number;
    healthy: number;
    unhealthy: number;
}

export class HealthMonitor {
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly manager: AddonManager,
        private readonly opts: {
            intervalMinutes: number;
            autoRefresh: boolean;
        }
    ) {}

    /** Run a single sweep over all enabled addons. */
    async checkAll(): Promise<HealthCheckSummary> {
        const addons = this.manager.getEnabled();
        let healthy = 0;
        for (let i = 0; i < addons.length; i += CONCURRENCY) {
            const batch = addons.slice(i, i + CONCURRENCY);
            const results = await Promise.all(
                batch.map((a) => this.checkOne(a.providerId, a.manifestUrl))
            );
            healthy += results.filter(Boolean).length;
        }
        return {
            checked: addons.length,
            healthy,
            unhealthy: addons.length - healthy
        };
    }

    private async checkOne(
        providerId: string,
        manifestUrl: string
    ): Promise<boolean> {
        try {
            if (this.opts.autoRefresh) {
                const r = await this.manager.refresh(providerId);
                this.manager.setHealth(
                    providerId,
                    r.ok,
                    r.ok ? undefined : r.error
                );
                return r.ok;
            }
            await fetchManifest(manifestUrl, 8000);
            this.manager.setHealth(providerId, true);
            return true;
        } catch (err) {
            this.manager.setHealth(
                providerId,
                false,
                err instanceof Error ? err.message : 'health check failed'
            );
            return false;
        }
    }

    /** Start the periodic sweep (no-op when interval <= 0). */
    start(): void {
        const minutes = this.opts.intervalMinutes;
        if (!minutes || minutes <= 0) {
            console.log('[health] periodic checks disabled (interval <= 0)');
            return;
        }
        const ms = minutes * 60 * 1000;
        // Kick an initial sweep shortly after boot, then on the interval.
        setTimeout(() => void this.checkAll(), 5000);
        this.timer = setInterval(() => void this.checkAll(), ms);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        console.log(
            `[health] monitoring every ${minutes}m` +
                (this.opts.autoRefresh ? ' (auto-refresh ON)' : '')
        );
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
