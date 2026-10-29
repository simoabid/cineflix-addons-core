/**
 * Source ranking unit tests (Phase 12 §15.5 "Smarter source selection").
 *
 * Covers the explainable scoring model, the stable provider-order tie-break,
 * and the `rank` info attached to every ranked source. Pure — no network,
 * no server, no fixtures.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    explainSourceScore,
    rankSources,
    DEFAULT_SOURCE_RANKING_WEIGHTS
} from '../dist/sources/ranking.js';

function src(overrides = {}) {
    return {
        id: 'src-1',
        name: 'Test Source',
        url: 'https://example/stream.mp4',
        quality: '1080p',
        type: 'direct',
        ...overrides
    };
}

const NO_TELEMETRY = { metrics: () => undefined };

describe('explainSourceScore', () => {
    test('direct 1080p source scores playability + quality', () => {
        const { score, reasons } = explainSourceScore(src(), NO_TELEMETRY);
        // playability 20 + quality 1080p (25*0.8=20) + confidence? (absent) = 40
        assert.equal(score, 40);
        assert.deepEqual(reasons, [
            'playability:direct(direct)',
            'quality:1080p(+20)'
        ]);
    });

    test('higher resolution scores higher', () => {
        const low = explainSourceScore(src({ quality: '480p' }), NO_TELEMETRY);
        const high = explainSourceScore(
            src({ quality: '2160p' }),
            NO_TELEMETRY
        );
        assert.equal(low.score, 20 + 6); // 25*0.25 = 6.25 → 6
        assert.equal(high.score, 20 + 25);
        assert.ok(high.score > low.score);
    });

    test('provider telemetry adds reliability and latency contributions', () => {
        const { score, reasons } = explainSourceScore(src(), {
            metrics: (pid) =>
                pid === 'addon:good'
                    ? {
                          attempts: 10,
                          successes: 9,
                          failures: 1,
                          avgLatency: 400
                      }
                    : undefined
        });
        // reliability 15*0.9=13.5→14 (rounded), latency 10 (fast), playability 20, quality 20
        assert.equal(score, 14 + 10 + 20 + 20);
        assert.ok(
            reasons.some((r) => r.startsWith('reliability:9/10')),
            reasons.join(',')
        );
        assert.ok(reasons.includes('latency:fast(400ms)'));
    });

    test('slow latency contributes nothing but is reported', () => {
        const { score, reasons } = explainSourceScore(src(), {
            metrics: () => ({
                attempts: 5,
                successes: 5,
                failures: 0,
                avgLatency: 15_000
            })
        });
        assert.ok(reasons.includes('latency:slow(15000ms)'));
        // reliability full 15, no latency points
        assert.equal(score, 15 + 20 + 20);
    });

    test('embed-type sources are penalized vs direct', () => {
        const direct = explainSourceScore(src(), NO_TELEMETRY);
        const embed = explainSourceScore(src({ type: 'torrent' }), NO_TELEMETRY);
        assert.equal(direct.score - embed.score, DEFAULT_SOURCE_RANKING_WEIGHTS.playability);
        assert.ok(embed.reasons.includes('playability:torrent'));
    });

    test('hdr/codec/size metadata stack', () => {
        const { score, reasons } = explainSourceScore(
            src({
                confidence: 'high',
                extra: { hdr: true, codec: 'hevc', sizeBytes: 123 }
            }),
            NO_TELEMETRY
        );
        // playability 20 + quality 20 + confidence 10 + hdr 3 + codec 2 + size 3
        assert.equal(score, 20 + 20 + 10 + 3 + 2 + 3);
        for (const r of ['confidence:high', 'hdr', 'codec:hevc', 'size:known']) {
            assert.ok(reasons.includes(r), r);
        }
    });

    test('custom weights are honored', () => {
        const { score } = explainSourceScore(src(), {
            weights: { quality: 0, playability: 1 }
        });
        assert.equal(score, 1);
    });
});

describe('rankSources', () => {
    test('sorts descending and attaches rank info', () => {
        const ranked = rankSources(
            [src({ quality: '480p' }), src({ quality: '2160p' })],
            NO_TELEMETRY
        );
        assert.equal(ranked[0].quality, '2160p');
        assert.ok(ranked[0].rank);
        assert.ok(ranked[0].rank!.score > ranked[1].rank!.score);
        assert.ok(ranked[0].rank!.reasons.length > 0);
    });

    test('stable tie-break preserves provider priority order', () => {
        const a = src({ id: 'a' }); // equal-score inputs
        const b = src({ id: 'b' });
        const c = src({ id: 'c' });
        const ranked = rankSources([a, b, c], NO_TELEMETRY);
        assert.deepEqual(
            ranked.map((r) => r.id),
            ['a', 'b', 'c']
        );
    });

    test('strictly better source from a later provider overtakes', () => {
        const first = src({ id: 'first', quality: '480p' });
        const second = src({ id: 'second', quality: '2160p' });
        const ranked = rankSources([first, second], NO_TELEMETRY);
        assert.equal(ranked[0].id, 'second');
    });

    test('returns empty list unchanged', () => {
        assert.deepEqual(rankSources([], NO_TELEMETRY), []);
    });
});
