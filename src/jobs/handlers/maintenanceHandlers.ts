import type { JobHandlerContext } from '../types.js';
import { toPublicAddon } from '../../addons/manager.js';
import { fetchManifest } from '../../stremio/client.js';

export async function manifestRefreshHandler(
    ctx: JobHandlerContext
): Promise<unknown> {
    const providerId = ctx.job.payload.providerId as string | undefined;

    if (providerId) {
        await ctx.updateProgress(20);
        const result = await ctx.manager.refresh(providerId);
        await ctx.updateProgress(100);
        return {
            ok: result.ok,
            error: result.error,
            addon: result.addon ? toPublicAddon(result.addon) : undefined
        };
    }

    // Refresh all stream-enabled addons
    const addons = ctx.manager.getStreamEnabled();
    const total = addons.length;
    let success = 0;
    const results = [];

    for (let i = 0; i < addons.length; i++) {
        if (ctx.signal.aborted) {
            throw Object.assign(new Error('Job cancelled'), {
                name: 'AbortError',
                code: 'CANCELLED'
            });
        }
        const a = addons[i];
        const res = await ctx.manager.refresh(a.providerId);
        if (res.ok) success++;
        results.push({
            providerId: a.providerId,
            ok: res.ok,
            error: res.error
        });
        await ctx.updateProgress(Math.round(((i + 1) / total) * 100));
        await ctx.heartbeat();
    }

    return {
        total,
        success,
        failed: total - success,
        results
    };
}

export async function healthSweepHandler(
    ctx: JobHandlerContext
): Promise<unknown> {
    const addons = ctx.manager.getStreamEnabled();
    let healthy = 0;
    const concurrency = 4;
    const results = [];

    for (let i = 0; i < addons.length; i += concurrency) {
        if (ctx.signal.aborted) {
            throw Object.assign(new Error('Job cancelled'), {
                name: 'AbortError',
                code: 'CANCELLED'
            });
        }

        const batch = addons.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (a) => {
                try {
                    await fetchManifest(a.manifestUrl, 8000);
                    ctx.manager.setHealth(a.providerId, true);
                    return { providerId: a.providerId, healthy: true };
                } catch (err) {
                    const msg =
                        err instanceof Error ? err.message : 'health check failed';
                    ctx.manager.setHealth(a.providerId, false, msg);
                    return { providerId: a.providerId, healthy: false, error: msg };
                }
            })
        );

        for (const r of batchResults) {
            results.push(r);
            if (r.healthy) healthy++;
        }

        await ctx.updateProgress(Math.round((results.length / addons.length) * 100));
        await ctx.heartbeat();
    }

    return {
        checked: addons.length,
        healthy,
        unhealthy: addons.length - healthy,
        results,
        revision: ctx.manager.getRevision()
    };
}

export async function maintenanceCleanupHandler(
    ctx: JobHandlerContext
): Promise<unknown> {
    await ctx.updateProgress(10);
    // 1. Cleanup expired playback grants
    const expiredGrants = await ctx.storage.cleanupExpiredGrants();
    await ctx.updateProgress(50);

    // 2. Cleanup finished/old jobs older than 7 days (or 24h)
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const cleanedJobs = await ctx.storage.cleanupJobs(maxAgeMs);
    await ctx.updateProgress(100);

    return {
        cleanedGrants: expiredGrants,
        cleanedJobs
    };
}
