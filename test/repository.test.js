import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepositoryPayload } from '../dist/import/repository.js';

test('parses JSON array of strings', () => {
    const raw = JSON.stringify([
        'https://a/manifest.json',
        'https://b/manifest.json'
    ]);
    assert.deepEqual(parseRepositoryPayload(raw, 'application/json'), [
        'https://a/manifest.json',
        'https://b/manifest.json'
    ]);
});

test('parses array of objects (transportUrl/url/manifestUrl)', () => {
    const raw = JSON.stringify([
        { transportUrl: 'https://a/manifest.json' },
        { url: 'https://b/manifest.json' },
        { manifestUrl: 'https://c/manifest.json' }
    ]);
    assert.deepEqual(parseRepositoryPayload(raw), [
        'https://a/manifest.json',
        'https://b/manifest.json',
        'https://c/manifest.json'
    ]);
});

test('parses Stremio collection { addons: [...] }', () => {
    const raw = JSON.stringify({
        addons: [
            { transportUrl: 'https://a/manifest.json', manifest: { name: 'A' } },
            { transportUrl: 'https://b/manifest.json' }
        ]
    });
    assert.deepEqual(parseRepositoryPayload(raw), [
        'https://a/manifest.json',
        'https://b/manifest.json'
    ]);
});

test('parses newline text with comments', () => {
    const raw = [
        '# my list',
        'https://a/manifest.json',
        '',
        'stremio://b/manifest.json',
        'not a url'
    ].join('\n');
    assert.deepEqual(parseRepositoryPayload(raw, 'text/plain'), [
        'https://a/manifest.json',
        'stremio://b/manifest.json'
    ]);
});

test('dedupes discovered urls', () => {
    const raw = JSON.stringify([
        'https://a/manifest.json',
        'https://a/manifest.json'
    ]);
    assert.deepEqual(parseRepositoryPayload(raw), ['https://a/manifest.json']);
});
