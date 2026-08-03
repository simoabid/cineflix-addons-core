import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sortAddons,
    compareAddons,
    priorityIndexMap
} from '../dist/priority.js';
import { isTorrentStream } from '../dist/debrid/torrentSources.js';

const mk = (providerId, order, name) => ({ providerId, order, name });

test('sortAddons orders by order then name', () => {
    const a = mk('a', 2, 'Zeta');
    const b = mk('b', 0, 'Beta');
    const c = mk('c', 0, 'Alpha');
    const sorted = sortAddons([a, b, c]).map((x) => x.providerId);
    assert.deepEqual(sorted, ['c', 'b', 'a']); // order 0 (Alpha,Beta) then order 2
});

test('compareAddons tie-breaks by name', () => {
    assert.ok(compareAddons(mk('a', 0, 'Alpha'), mk('b', 0, 'Beta')) < 0);
});

test('priorityIndexMap assigns contiguous indices', () => {
    const map = priorityIndexMap([
        mk('a', 5, 'A'),
        mk('b', 1, 'B'),
        mk('c', 3, 'C')
    ]);
    assert.equal(map.get('b'), 0);
    assert.equal(map.get('c'), 1);
    assert.equal(map.get('a'), 2);
});

test('isTorrentStream detects infoHash-only streams', () => {
    assert.equal(isTorrentStream({ infoHash: 'abc' }), true);
    assert.equal(isTorrentStream({ infoHash: 'abc', url: 'https://x' }), false);
    assert.equal(isTorrentStream({ url: 'https://x' }), false);
    assert.equal(isTorrentStream({}), false);
});
