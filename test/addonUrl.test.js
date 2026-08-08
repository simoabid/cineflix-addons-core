import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseAddonUrl,
    buildResourceUrl,
    sameAddonIdentity
} from '../dist/stremio/url.js';

test('parseAddonUrl preserves query string', () => {
    const raw = 'https://host.example/addon?token=abc123&opts=1';
    const p = parseAddonUrl(raw);
    assert.equal(p.search, '?token=abc123&opts=1');
    assert.ok(p.baseUrl.includes('?token='));
    assert.ok(p.manifestUrl.includes('?token='));
    assert.ok(p.baseUrl.endsWith('?token=abc123&opts=1'));
    assert.ok(p.manifestUrl.endsWith('/manifest.json?token=abc123&opts=1'));
});

test('parseAddonUrl handles path-configured manifests (torrentio style)', () => {
    const raw = 'https://torrentio.strem.fun/EyJkZWJyaWQiOiIxIn0=/manifest.json';
    const p = parseAddonUrl(raw);
    assert.equal(p.pathnameBase, '/EyJkZWJyaWQiOiIxIn0=');
    assert.equal(p.baseUrl, 'https://torrentio.strem.fun/EyJkZWJyaWQiOiIxIn0=');
    assert.equal(p.manifestUrl, 'https://torrentio.strem.fun/EyJkZWJyaWQiOiIxIn0=/manifest.json');
});

test('parseAddonUrl handles bare host + stremio:// scheme', () => {
    const a = parseAddonUrl('stremio://torrentio.strem.fun/manifest.json');
    assert.equal(a.manifestUrl, 'https://torrentio.strem.fun/manifest.json');
    const b = parseAddonUrl('torrentio.strem.fun');
    assert.equal(b.manifestUrl, 'https://torrentio.strem.fun/manifest.json');
    assert.equal(b.baseUrl, 'https://torrentio.strem.fun');
});

test('buildResourceUrl preserves query config', () => {
    const base = 'https://host.example/addon?token=secret123';
    const url = buildResourceUrl(base, 'stream', 'movie', 'tt1234567');
    assert.ok(url.includes('/stream/movie/tt1234567.json?token=secret123'));
    assert.ok(!url.includes('manifest.json'));
});

test('buildResourceUrl respects path config', () => {
    const base = 'https://torrentio.strem.fun/EyJkZWJyaWQiOiIxIn0=';
    const url = buildResourceUrl(base, 'stream', 'series', 'tt123:1:2');
    assert.ok(url.startsWith('https://torrentio.strem.fun/EyJkZWJyaWQiOiIxIn0=/stream/series/tt123%3A1%3A2.json'));
});

test('sameAddonIdentity uses fingerprint (sorted query, lower host)', () => {
    const a = 'https://Host.Example/addon?b=2&a=1';
    const b = 'https://host.example/addon?a=1&b=2';
    assert.ok(sameAddonIdentity(a, b));
    const c = 'https://host.example/addon?a=1&b=2';
    const d = 'https://host.example/addon?a=1&b=3';
    assert.equal(sameAddonIdentity(c, d), false);
    // different path → not same
    assert.equal(sameAddonIdentity('https://host.example/a/manifest.json', 'https://host.example/b/manifest.json'), false);
});

test('parseAddonUrl fingerprint stable for query order and host case', () => {
    const p1 = parseAddonUrl('https://HOST.example/addon?z=9&a=1&m=5');
    const p2 = parseAddonUrl('https://host.example/addon?a=1&m=5&z=9');
    assert.equal(p1.fingerprint, p2.fingerprint);
});

test('preserve originalImportUrl vs normalized manifestUrl separation', () => {
    const original = 'https://example.com/addon?token=abc';
    const p = parseAddonUrl(original);
    assert.equal(p.original, original);
    assert.notEqual(p.original, p.manifestUrl);
    assert.ok(p.manifestUrl.includes('manifest.json?token=abc'));
});
