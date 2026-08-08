import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderSelectionService } from '../dist/providers/selection.js';
import { ReliabilityRegistry } from '../dist/reliability/circuit.js';

function mkAddon(providerId, order, name, caps, enabled = true) {
    // Build manifest idPrefixes from first stream entry for accurate buildIdCandidates filtering
    const firstStream = caps.stream && caps.stream[0];
    const idPrefixes = firstStream ? firstStream.idPrefixes : undefined;
    const manifest = { id: providerId.replace('addon:', ''), name };
    if (idPrefixes) manifest.idPrefixes = idPrefixes;
    // Also propagate types for media-type filtering parity
    if (firstStream && firstStream.mediaTypes.length) {
        // Map back to Stremio types: movie->movie, series->series
        manifest.types = firstStream.mediaTypes.map((m) => (m === 'movie' ? 'movie' : 'series'));
    }
    return { providerId, order, name, enabled, capabilities: caps, manifest };
}

function capsFrom({ stream = [], subtitles = [] }) {
    return {
        stream,
        subtitles,
        catalog: false,
        meta: false,
        status: stream.length || subtitles.length ? 'supported' : 'limited',
        resources: []
    };
}

test('selectStreamProviders respects priority order', () => {
    const manager = {
        getStreamEnabled: () => [
            mkAddon('addon:b', 1, 'B', capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] })),
            mkAddon('addon:a', 0, 'A', capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] })),
            mkAddon('addon:c', 2, 'C', capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] }))
        ].sort((x, y) => x.order - y.order),
        getSubtitleEnabled: () => [],
        getRevision: () => 5
    };
    const sel = new ProviderSelectionService(manager);
    const media = { type: 'movie', tmdbId: '1', imdbId: 'tt1', title: 'T', releaseYear: '2020' };
    const out = sel.selectStreamProviders(media).map((a) => a.providerId);
    assert.deepEqual(out, ['addon:a', 'addon:b', 'addon:c']);
});

test('selectStreamProviders filters disabled and non-stream', () => {
    const manager = {
        getStreamEnabled: () => [
            mkAddon('addon:ok', 0, 'Ok', capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] }), true),
            mkAddon('addon:disabled', 1, 'Dis', capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] }), false),
            mkAddon('addon:catalog', 2, 'Cat', capsFrom({ stream: [] }), true)
        ].filter((a) => a.enabled && a.capabilities.stream.length),
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };
    const sel = new ProviderSelectionService(manager);
    const media = { type: 'movie', tmdbId: '1', imdbId: 'tt1', title: '', releaseYear: '' };
    const out = sel.selectStreamProviders(media);
    // getStreamEnabled already filtered, so selection just returns that
    assert.equal(out.length, 1);
    assert.equal(out[0].providerId, 'addon:ok');
});

test('selectStreamProviders filters by media type', () => {
    const movieOnly = capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] });
    const seriesOnly = capsFrom({ stream: [{ mediaTypes: ['series'], idPrefixes: ['tt'] }] });
    const both = capsFrom({ stream: [{ mediaTypes: ['movie', 'series'], idPrefixes: ['tt'] }] });
    const manager = {
        getStreamEnabled: () => [
            mkAddon('addon:movie', 0, 'Movie', movieOnly),
            mkAddon('addon:series', 1, 'Series', seriesOnly),
            mkAddon('addon:both', 2, 'Both', both)
        ],
        getSubtitleEnabled: () => [],
        getRevision: () => 0
    };
    const sel = new ProviderSelectionService(manager);
    const movieMedia = { type: 'movie', tmdbId: '1', imdbId: 'tt1', title: '', releaseYear: '' };
    const tvMedia = { type: 'tv', tmdbId: '1', imdbId: 'tt1', title: '', releaseYear: '', s: 1, e: 1 };
    assert.deepEqual(sel.selectStreamProviders(movieMedia).map((a) => a.providerId).sort(), ['addon:both', 'addon:movie'].sort());
    assert.deepEqual(sel.selectStreamProviders(tvMedia).map((a) => a.providerId).sort(), ['addon:both', 'addon:series'].sort());
});

test('selectStreamProviders filters by id prefix compatibility', () => {
    const ttOnly = capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] });
    const tmdbOnly = capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tmdb'] }] });
    const manager = {
        getStreamEnabled: () => [
            mkAddon('addon:tt', 0, 'TT', ttOnly),
            mkAddon('addon:tmdb', 1, 'TMDB', tmdbOnly)
        ],
        getSubtitleEnabled: () => [],
        getRevision: () => 0
    };
    const sel = new ProviderSelectionService(manager);
    const withImdb = { type: 'movie', tmdbId: '603', imdbId: 'tt0133093', title: '', releaseYear: '' };
    const onlyTmdb = { type: 'movie', tmdbId: '603', imdbId: '', title: '', releaseYear: '' };
    const res1 = sel.selectStreamProviders(withImdb).map((a) => a.providerId);
    // ttOnly should match via tt, tmdbOnly via tmdb fallback? but withImdb has both tt and tmdb so both match
    assert.ok(res1.includes('addon:tt'));
    // only tmdb available: ttOnly needs tt, so it should be filtered out when only tmdb present
    const res2 = sel.selectStreamProviders(onlyTmdb).map((a) => a.providerId);
    assert.ok(!res2.includes('addon:tt'));
    assert.ok(res2.includes('addon:tmdb'));
});

test('selection respects circuit open (skip) unless includeCircuitOpen', () => {
    const cap = capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] });
    const manager = {
        getStreamEnabled: () => [
            mkAddon('addon:a', 0, 'A', cap),
            mkAddon('addon:b', 1, 'B', cap)
        ],
        getSubtitleEnabled: () => [],
        getRevision: () => 0
    };
    const rel = new ReliabilityRegistry({ failureThreshold: 2, openTtlMs: 60_000 });
    rel.recordFailure('addon:a', 'timeout');
    rel.recordFailure('addon:a', 'timeout');
    assert.equal(rel.getState('addon:a'), 'open');
    const sel = new ProviderSelectionService(manager, rel);
    const media = { type: 'movie', tmdbId: '1', imdbId: 'tt1', title: '', releaseYear: '' };
    const without = sel.selectStreamProviders(media).map((a) => a.providerId);
    assert.deepEqual(without, ['addon:b']);
    const withOpen = sel.selectStreamProviders(media, { includeCircuitOpen: true }).map((a) => a.providerId);
    assert.ok(withOpen.includes('addon:a'));
});

test('revision is exposed on selection', () => {
    const manager = { getStreamEnabled: () => [], getSubtitleEnabled: () => [], getRevision: () => 42 };
    const sel = new ProviderSelectionService(manager);
    assert.equal(sel.revision, 42);
});

test('fetchAggregate respects priority order and bounded concurrency', async () => {
    const cap = capsFrom({ stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }] });
    const manager = {
        getStreamEnabled: () => [
            mkAddon('addon:a', 0, 'A', cap),
            mkAddon('addon:b', 1, 'B', cap),
            mkAddon('addon:c', 2, 'C', cap)
        ],
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };
    const sel = new ProviderSelectionService(manager);
    const media = { type: 'movie', tmdbId: '1', imdbId: 'tt1', title: '', releaseYear: '' };
    const order = [];
    const fetcher = async (addon) => {
        order.push(addon.providerId);
        return { ok: true, provider: addon.providerId };
    };
    const res = await sel.fetchAggregate(media, fetcher, { concurrency: 1 });
    assert.deepEqual(order, ['addon:a', 'addon:b', 'addon:c']);
    assert.deepEqual(res.map((r) => r.addon.providerId), ['addon:a', 'addon:b', 'addon:c']);
});
