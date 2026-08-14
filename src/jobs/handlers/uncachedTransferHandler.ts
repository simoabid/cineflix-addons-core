import type { JobHandlerContext } from '../types.js';
import { debridService } from '../../debrid/service.js';
import { isValidInfoHash } from '../../debrid/magnet.js';
import { createSecureProxyContext } from '../../security/proxyRoute.js';
import type { DebridResolution } from '../../debrid/types.js';

export interface UncachedTransferPayload {
    infoHash: string;
    sources?: string[];
    fileIdx?: number;
    season?: number;
    episode?: number;
    title?: string;
    maxWaitSec?: number;
}

async function wrapWithPlaybackGrant(
    rawUrl: string,
    ctx: JobHandlerContext
): Promise<string> {
    if (!ctx.cfg.secureProxy) {
        return rawUrl;
    }
    try {
        const proxyCtx = createSecureProxyContext(ctx.cfg);
        const grant = await proxyCtx.grants.issue({
            url: rawUrl,
            singleUse: false,
            ttlSec: ctx.cfg.playbackGrantTtlSec ?? 7200
        });
        const base = (
            ctx.cfg.publicUrl || `http://${ctx.cfg.host}:${ctx.cfg.port}`
        ).replace(/\/+$/, '');
        return proxyCtx.grants.toProxyUrl(grant, base);
    } catch {
        return rawUrl;
    }
}

export async function uncachedTransferHandler(
    ctx: JobHandlerContext
): Promise<Record<string, unknown>> {
    const payload = ctx.job.payload as unknown as UncachedTransferPayload;
    if (!payload?.infoHash || !isValidInfoHash(payload.infoHash)) {
        throw new Error(
            `Invalid or missing infoHash in payload: ${payload?.infoHash}`
        );
    }

    if (!debridService.isEnabled()) {
        throw new Error('Debrid service is disabled or not configured');
    }

    const resolver = debridService.getResolver();
    if (!resolver) {
        throw new Error('No active debrid resolver found');
    }

    // Step 1: Initial resolution with allowUncached = true (submits magnet once)
    await ctx.updateProgress(5);
    const initial = await debridService.resolveCached({
        infoHash: payload.infoHash,
        sources: payload.sources,
        fileIdx: payload.fileIdx,
        season: payload.season,
        episode: payload.episode,
        title: payload.title,
        allowUncached: true
    });

    if (initial.kind === 'resolved') {
        await ctx.updateProgress(100);
        const grantUrl = await wrapWithPlaybackGrant(initial.url, ctx);
        return {
            status: 'completed',
            url: grantUrl,
            selectedFile: initial.selectedFile,
            cached: true
        };
    }

    if (initial.kind === 'invalid-torrent') {
        throw new Error(`Torrent rejected: ${initial.reason}`);
    }

    if (initial.kind === 'provider-error') {
        throw new Error(`Provider error: ${initial.safeMessage}`);
    }

    const torrentId = initial.torrentId;
    const maxWaitMs = (payload.maxWaitSec ?? 1800) * 1000; // Default: 30 mins
    const startTime = Date.now();
    const pollIntervalMs = 3000;

    try {
        while (Date.now() - startTime < maxWaitMs) {
            if (ctx.signal.aborted) {
                if (torrentId) await debridService.cleanup(torrentId);
                throw Object.assign(new Error('Transfer job cancelled'), {
                    name: 'AbortError',
                    code: 'CANCELLED'
                });
            }

            await ctx.heartbeat();

            // Poll using dedicated transfer status polling (no re-uploading magnet)
            let current: DebridResolution;
            if (torrentId) {
                current = await debridService.pollTransferStatus(torrentId, {
                    fileIdx: payload.fileIdx,
                    season: payload.season,
                    episode: payload.episode,
                    title: payload.title
                });
            } else {
                current = await debridService.resolveCached({
                    infoHash: payload.infoHash,
                    sources: payload.sources,
                    fileIdx: payload.fileIdx,
                    season: payload.season,
                    episode: payload.episode,
                    title: payload.title,
                    allowUncached: true
                });
            }

            if (current.kind === 'resolved') {
                await ctx.updateProgress(100);
                const grantUrl = await wrapWithPlaybackGrant(current.url, ctx);
                return {
                    status: 'completed',
                    url: grantUrl,
                    selectedFile: current.selectedFile,
                    cached: false
                };
            }

            if (current.kind === 'invalid-torrent') {
                if (torrentId) await debridService.cleanup(torrentId);
                throw new Error(`Torrent failed: ${current.reason}`);
            }

            if (
                current.kind === 'uncached' &&
                typeof current.progress === 'number'
            ) {
                // Scale progress between 10% and 95%
                const scaled = Math.min(
                    95,
                    Math.max(10, Math.round(current.progress))
                );
                await ctx.updateProgress(scaled);
            }

            await delay(pollIntervalMs, ctx.signal);
        }

        // Timed out
        if (torrentId) await debridService.cleanup(torrentId);
        throw new Error(
            `Transfer timed out after ${Math.round(maxWaitMs / 1000)} seconds`
        );
    } catch (err) {
        if (torrentId && ctx.signal.aborted) {
            await debridService.cleanup(torrentId);
        }
        throw err;
    }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            return reject(
                Object.assign(new Error('Cancelled'), { name: 'AbortError' })
            );
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(
                    Object.assign(new Error('Cancelled'), {
                        name: 'AbortError'
                    })
                );
            },
            { once: true }
        );
    });
}
