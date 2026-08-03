import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeInfoHash,
    isValidInfoHash,
    buildMagnet,
    infoHashFromMagnet,
    isVideoFile,
    isSampleFile,
    pickFileIndex
} from '../dist/debrid/magnet.js';

test('normalizeInfoHash lowercases', () => {
    assert.equal(
        normalizeInfoHash('  ABCDEF0123456789ABCDEF0123456789ABCDEF01 '),
        'abcdef0123456789abcdef0123456789abcdef01'
    );
});

test('isValidInfoHash accepts 40-hex and 32-base32', () => {
    assert.equal(isValidInfoHash('a'.repeat(40)), true);
    assert.equal(isValidInfoHash('A'.repeat(32)), true);
    assert.equal(isValidInfoHash('xyz'), false);
});

test('buildMagnet includes xt + fallback trackers', () => {
    const m = buildMagnet('a'.repeat(40));
    assert.ok(m.startsWith('magnet:?xt=urn:btih:' + 'a'.repeat(40)));
    assert.ok(m.includes('tr='));
});

test('buildMagnet keeps supplied trackers over fallback', () => {
    const m = buildMagnet('a'.repeat(40), [
        'tracker:udp://custom:1337/announce',
        'dht:ignored'
    ]);
    assert.ok(m.includes(encodeURIComponent('udp://custom:1337/announce')));
    assert.ok(!m.includes('opentrackr'));
});

test('infoHashFromMagnet round-trips', () => {
    const h = 'b'.repeat(40);
    assert.equal(infoHashFromMagnet(buildMagnet(h)), h);
    assert.equal(infoHashFromMagnet('not-a-magnet'), null);
});

test('isVideoFile / isSampleFile', () => {
    assert.equal(isVideoFile('Movie.2020.1080p.mkv'), true);
    assert.equal(isVideoFile('readme.txt'), false);
    assert.equal(isSampleFile('sample.mkv'), true);
    assert.equal(isSampleFile('feature.mkv'), false);
});

test('pickFileIndex: explicit fileIdx wins', () => {
    const files = [
        { name: 'a.mkv', size: 100 },
        { name: 'b.mkv', size: 999 }
    ];
    assert.equal(pickFileIndex(files, { fileIdx: 0 }), 0);
});

test('pickFileIndex: largest video otherwise', () => {
    const files = [
        { name: 'sample.mkv', size: 10 },
        { name: 'feature.mkv', size: 900 },
        { name: 'notes.txt', size: 5000 }
    ];
    assert.equal(pickFileIndex(files), 1);
});

test('pickFileIndex: season/episode match', () => {
    const files = [
        { name: 'Show.S01E01.mkv', size: 100 },
        { name: 'Show.S01E02.mkv', size: 100 },
        { name: 'Show.S01E03.mkv', size: 100 }
    ];
    assert.equal(pickFileIndex(files, { season: 1, episode: 2 }), 1);
});

test('pickFileIndex: empty list → -1', () => {
    assert.equal(pickFileIndex([]), -1);
});
