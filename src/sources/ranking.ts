/**
 * SourceRankingService — Phase 12 §15.5 "Smarter source selection".
 *
 * An explainable re-ranking model for bulk-aggregated source lists. Scoring
 * inputs (per the plan):
 *
 *   - Provider reliability and latency (ReliabilityRegistry metrics)
 *   - Source type / playability (direct http vs embed, normalization confidence)
 *   - Quality / size / codec metadata (from source normalization `extra`)
 *
 * Policy guarantees required by the plan:
 *   - Explicit user provider order is NEVER silently replaced: ranking is
 *     opt-in (`SOURCE_RANKING_ENABLED=false` by default), the per-source score
 *     and reasons are surfaced on every ranked source (`rank` field), and the
 *     original provider order is the stable tie-break — a provider's sources
 *     can only move ahead of a *strictly lower-scoring* source from another
 *     provider, never ahead of an equal one.
 */

import type { Source } from '@omss/framework';

/** Contributing factors with their default weights (max contribution each). */
export interface SourceRankingWeights {
    /** Provider success ratio (successes/(successes+failures)) × weight. */
    reliability: number;
    /** Provider avg latency ≤ 1500ms gets the full weight, decaying to 0 at 10s. */
    latency: number;
    /** Direct-play types (http/mp4/hls/dash) vs embed. */
    playability: number;
    /** Normalization confidence high/medium/low. */
    confidence: number;
    /** Resolution tier (2160p > 1080p > 720p > 480p > unknown). */
    quality: number;
    /** Known content size (sizeBytes present). */
    size: number;
    /** HDR flag. */
    hdr: number;
    /** Modern codec (hevc/av1). */
    codec: number;
}

export const DEFAULT_SOURCE_RANKING_WEIGHTS: SourceRankingWeights = {
    reliability: 15,
    latency: 10,
    playability: 20,
    confidence: 10,
    quality: 25,
    size: 3,
    hdr: 3,
    codec: 2
};

/** Provider telemetry the ranking needs (ReliabilityRegistry.getMetrics). */
export interface ProviderRankingMetrics {
    attempts: number;
    successes: number;
    failures: number;
    avgLatency?: number;
}

export interface SourceRankContext {
    metrics?: (providerId: string) => ProviderRankingMetrics | undefined;
    weights?: Partial<SourceRankingWeights>;
}

/** Explainable score attached to each ranked source when ranking is enabled. */
export interface SourceRankInfo {
    score: number;
    reasons: string[];
}

export interface RankedSource extends Source {
    /** Present only when source ranking is enabled (Phase 12 §15.5). */
    rank?: SourceRankInfo;
}

const QUALITY_TIERS: Array<[RegExp, number, string]> = [
    [/^2160p$/, 1.0, '2160p'],
    [/^1080p$/, 0.8, '1080p'],
    [/^720p$/, 0.5, '720p'],
    [/^480p$/, 0.25, '480p']
];

const DIRECT_TYPES = new Set(['http', 'mp4', 'mkv', 'webm', 'hls', 'dash']);

// ── Pure scoring (unit-testable) ─────────────────────────────────────────────

/** Score a single source; every contributing factor is listed in reasons. */
export function explainSourceScore(
    source: Source,
    ctx: SourceRankContext = {}
): { score: number; reasons: string[] } {
    const w = { ...DEFAULT_SOURCE_RANKING_WEIGHTS, ...ctx.weights };
    const reasons: string[] = [];
    let score = 0;

    // Provider reliability + latency (only when telemetry exists).
    const m = ctx.metrics?.(source.provider?.id);
    if (m && m.attempts > 0) {
        const decisive = m.successes + m.failures;
        if (decisive > 0) {
            const ratio = m.successes / decisive;
            const contrib = Math.round(w.reliability * ratio);
            score += contrib;
            if (contrib > 0)
                reasons.push(`reliability:${m.successes}/${decisive}(+${contrib})`);
            else reasons.push(`reliability:low(${m.successes}/${decisive})`);
        }
        if (m.avgLatency != null) {
            if (m.avgLatency <= 1500) {
                score += w.latency;
                reasons.push(`latency:fast(${m.avgLatency}ms)`);
            } else if (m.avgLatency <= 10_000) {
                // Linear decay from full weight at 1.5s to 0 at 10s.
                const t = (10_000 - m.avgLatency) / 8_500;
                const contrib = Math.round(w.latency * t);
                if (contrib > 0) {
                    score += contrib;
                    reasons.push(`latency:${m.avgLatency}ms(+${contrib})`);
                }
            } else {
                reasons.push(`latency:slow(${m.avgLatency}ms)`);
            }
        }
    }

    // Playability: direct types are immediately consumable by players;
    // embeds require a browser and are effectively last-resort.
    if (DIRECT_TYPES.has(source.type)) {
        score += w.playability;
        reasons.push(`playability:direct(${source.type})`);
    } else {
        reasons.push(`playability:${source.type}`);
    }

    // Normalization confidence (quality inferable + typed).
    const conf = (source as { confidence?: string }).confidence;
    if (conf === 'high') {
        score += w.confidence;
        reasons.push('confidence:high');
    } else if (conf === 'medium') {
        score += Math.round(w.confidence / 2);
        reasons.push('confidence:medium');
    }

    // Quality tier.
    const quality = String(source.quality ?? '').toLowerCase();
    const tier = QUALITY_TIERS.find(([re]) => re.test(quality));
    if (tier) {
        const contrib = Math.round(w.quality * tier[1]);
        score += contrib;
        reasons.push(`quality:${tier[2]}(+${contrib})`);
    } else if (quality) {
        reasons.push(`quality:${quality}`);
    }

    // Metadata enrichments from source normalization.
    const extra = (
        source as {
            extra?: { hdr?: boolean; codec?: string; sizeBytes?: number };
        }
    ).extra;
    if (extra?.hdr) {
        score += w.hdr;
        reasons.push('hdr');
    }
    if (extra?.codec && /hevc|h265|av1|dolby/i.test(extra.codec)) {
        score += w.codec;
        reasons.push(`codec:${extra.codec.toLowerCase()}`);
    }
    if (typeof extra?.sizeBytes === 'number' && extra.sizeBytes > 0) {
        score += w.size;
        reasons.push('size:known');
    }

    return { score, reasons };
}

/**
 * Re-rank a flattened source list by explainable score (descending), with the
 * original index as a strict tie-break so user provider priority order is
 * preserved among equal-scoring sources.
 */
export function rankSources(
    sources: Source[],
    ctx: SourceRankContext = {}
): RankedSource[] {
    const scored = sources.map((source, index) => ({
        source,
        index,
        ...explainSourceScore(source, ctx)
    }));
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map(({ source, score, reasons }) => ({
        ...source,
        rank: { score, reasons }
    }));
}