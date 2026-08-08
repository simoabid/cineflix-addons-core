import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveCapabilities,
    normalizeResources,
    isStreamCapable,
    isSubtitleCapable
} from '../dist/capabilities/index.js';

test('normalizeResources parses string and object resources', () => {
    const manifest = {
        id: 'a',
        name: 'A',
        types: ['movie', 'series'],
        resources: [
            'stream',
            { name: 'subtitles', types: ['movie'], idPrefixes: ['tt'] },
            { name: 'catalog', types: ['movie'] }
        ]
    };
    const res = normalizeResources(manifest);
    assert.equal(res.length, 3);
    assert.equal(res[0].name, 'stream');
    // manifest types movie+series => stream inherits those two (tv not implied)
    assert.deepEqual(res[0].mediaTypes.sort(), ['movie', 'series'].sort());
    // subtitles entry overrides types to movie only
    assert.deepEqual(res[1].mediaTypes, ['movie']);
    assert.deepEqual(res[1].idPrefixes, ['tt']);
    assert.equal(res[2].name, 'catalog');
});

test('merges manifest-level and resource-level types/idPrefixes correctly', () => {
    const manifest = {
        id: 'x',
        name: 'X',
        types: ['movie'],
        idPrefixes: ['tt', 'tmdb'],
        resources: [
            { name: 'stream' }, // should inherit movie + tt/tmdb
            { name: 'subtitles', types: ['series'], idPrefixes: ['tt'] }
        ]
    };
    const caps = deriveCapabilities(manifest);
    // stream inherits manifest
    assert.deepEqual(caps.stream[0].mediaTypes, ['movie']);
    assert.deepEqual(caps.stream[0].idPrefixes.sort(), ['tmdb', 'tt'].sort());
    // subtitles overrides
    assert.deepEqual(caps.subtitles[0].mediaTypes, ['series']);
    assert.deepEqual(caps.subtitles[0].idPrefixes, ['tt']);
});

test('resource-level idPrefixes override manifest idPrefixes', () => {
    const manifest = {
        id: 'y',
        name: 'Y',
        idPrefixes: ['tt'],
        resources: [
            { name: 'stream', idPrefixes: ['tmdb'] }
        ]
    };
    const caps = deriveCapabilities(manifest);
    assert.deepEqual(caps.stream[0].idPrefixes, ['tmdb']);
});

test('distinguishes stream, subtitles, catalog, meta capabilities', () => {
    const streamOnly = { id: 's', name: 'S', resources: ['stream'] };
    const subOnly = { id: 'sub', name: 'Sub', resources: ['subtitles'] };
    const catalogOnly = { id: 'c', name: 'C', resources: ['catalog'] };
    const metaOnly = { id: 'm', name: 'M', resources: ['meta'] };
    const mixed = { id: 'mix', name: 'Mix', resources: ['stream', 'subtitles', 'catalog'] };
    assert.ok(isStreamCapable(deriveCapabilities(streamOnly)));
    assert.equal(isSubtitleCapable(deriveCapabilities(streamOnly)), false);
    assert.equal(isStreamCapable(deriveCapabilities(subOnly)), false);
    assert.ok(isSubtitleCapable(deriveCapabilities(subOnly)));
    const catCaps = deriveCapabilities(catalogOnly);
    assert.equal(catCaps.stream.length, 0);
    assert.equal(catCaps.catalog, true);
    assert.equal(catCaps.status, 'limited');
    const metaCaps = deriveCapabilities(metaOnly);
    assert.equal(metaCaps.meta, true);
    assert.equal(metaCaps.status, 'limited');
    const mixCaps = deriveCapabilities(mixed);
    assert.equal(mixCaps.stream.length, 1);
    assert.equal(mixCaps.subtitles.length, 1);
    assert.equal(mixCaps.catalog, true);
    assert.equal(mixCaps.status, 'supported');
});

test('unsupported status for no advertised resources', () => {
    const empty = { id: 'e', name: 'E', resources: [] };
    const noRes = { id: 'n', name: 'N' };
    const unknown = { id: 'u', name: 'U', resources: ['catalog'] }; // catalog only -> limited, not unsupported
    assert.equal(deriveCapabilities(empty).status, 'unsupported');
    assert.equal(deriveCapabilities(noRes).status, 'unsupported');
    // one with no stream/subs but catalog => limited
    assert.equal(deriveCapabilities({ id: 'c2', name: 'C2', resources: ['catalog', 'meta'] }).status, 'limited');
    // one with stream but also unsupported filtering
    const ok = { id: 'ok', name: 'Ok', resources: ['stream'] };
    assert.equal(deriveCapabilities(ok).status, 'supported');
});

test('resource-level type filtering covers idPrefixes rules', () => {
    const manifest = {
        id: 'pref',
        name: 'Pref',
        resources: [
            { name: 'stream', types: ['movie'], idPrefixes: ['tt'] },
            { name: 'stream', types: ['series'], idPrefixes: ['tmdb'] }
        ]
    };
    const caps = deriveCapabilities(manifest);
    assert.equal(caps.stream.length, 2);
    assert.deepEqual(caps.stream[0].mediaTypes, ['movie']);
    assert.deepEqual(caps.stream[0].idPrefixes, ['tt']);
    assert.deepEqual(caps.stream[1].mediaTypes, ['series']);
    assert.deepEqual(caps.stream[1].idPrefixes, ['tmdb']);
});

test('unknown resource names are ignored', () => {
    const manifest = { id: 'unk', name: 'Unk', resources: ['stream', 'bogus', { name: 'notreal' }] };
    const caps = deriveCapabilities(manifest);
    assert.equal(caps.stream.length, 1);
    assert.equal(caps.status, 'supported');
});

test('catalog/meta booleans exposed correctly', () => {
    const m = { id: 'cm', name: 'CM', resources: ['catalog', 'meta'] };
    const caps = deriveCapabilities(m);
    assert.equal(caps.catalog, true);
    assert.equal(caps.meta, true);
    assert.equal(caps.stream.length, 0);
});
