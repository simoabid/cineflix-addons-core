/**
 * Catalog passthrough unit tests (Phase 12 §15.1) — normalization layer.
 *
 * Runs against the compiled artifact (ADR 0005): exercises meta namespacing,
 * dedup, item caps, type normalization, and extra-parameter sanitization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeCatalogEntries,
    normalizeCatalogType,
    extraKey
} from '../dist/catalogs/normalization.js';
import { sanitizeExtra } from '../dist/catalogs/service.js';

const PROVIDER = 'addon:org-catalog';

test('catalog entries are namespaced with the provider id', () => {
    const entries = normalizeCatalogEntries(
        [{ id: 'tt123', name: 'Example Movie', type: 'movie' }],
        PROVIDER
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, `${PROVIDER}:tt123`);
    assert.equal(entries[0].metaId, 'tt123');
    assert.equal(entries[0].name, 'Example Movie');
    assert.equal(entries[0].type, 'movie');
    assert.equal(entries[0].providerId, PROVIDER);
});

test('duplicate entries and malformed rows are dropped; cap is enforced', () => {
    const rows = [
        { id: 'a', name: 'A', type: 'movie' },
        { id: 'a', name: 'A dup', type: 'movie' }, // dedup
        { id: '', name: 'no id' }, // malformed
        null, // malformed
        { name: 'no id field' }, // malformed
        ...Array.from({ length: 30 }, (_, i) => ({
            id: `k${i}`,
            name: `K${i}`,
            type: 'series'
        }))
    ];
    const entries = normalizeCatalogEntries(rows, PROVIDER, { maxItems: 10 });
    assert.equal(entries.length, 10); // a + k0..k8
    assert.ok(!entries.some((e) => e.metaId === 'a' && e.name === 'A dup'));
    assert.equal(entries[0].metaId, 'a');
    assert.equal(entries[entries.length - 1].metaId, 'k8');
});

test('type normalization maps anime/channel to series/tv buckets', () => {
    assert.equal(normalizeCatalogType('movie'), 'movie');
    assert.equal(normalizeCatalogType('series'), 'series');
    assert.equal(normalizeCatalogType('anime'), 'series');
    assert.equal(normalizeCatalogType('channel'), 'tv');
    assert.equal(normalizeCatalogType('tv'), 'tv');
    assert.equal(normalizeCatalogType(undefined), 'other');
});

test('optional metadata fields are copied only when strings/arrays', () => {
    const entries = normalizeCatalogEntries(
        [
            {
                id: 'm1',
                name: 'M1',
                type: 'movie',
                poster: 'https://img/poster.jpg',
                description: 'desc',
                releaseInfo: '2001',
                imdbRating: '7.5',
                runtime: '120 min',
                genres: ['Drama', 42, 'Sci-Fi'],
                posterExtra: 'should-not-leak'
            }
        ],
        PROVIDER
    );
    const e = entries[0];
    assert.equal(e.poster, 'https://img/poster.jpg');
    assert.equal(e.description, 'desc');
    assert.deepEqual(e.genres, ['Drama', 'Sci-Fi']);
    assert.equal('posterExtra' in e, false);
    assert.equal('background' in e, false);
});

test('extraKey is order-insensitive and stable', () => {
    assert.equal(
        extraKey({ genre: 'drama', skip: '10' }),
        extraKey({ skip: '10', genre: 'drama' })
    );
    assert.notEqual(
        extraKey({ genre: 'drama' }),
        extraKey({ genre: 'comedy' })
    );
    assert.equal(extraKey(undefined), 'none');
});

test('sanitizeExtra keeps only declared params and defaults required enums', () => {
    const descriptor = {
        type: 'movie',
        id: 'top',
        name: 'Top',
        extra: [
            { name: 'genre', options: ['drama', 'comedy'] },
            { name: 'search' },
            { name: 'jump', isRequired: true, options: ['start', 'end'] }
        ]
    };
    const cleaned = sanitizeExtra(descriptor, {
        genre: 'drama',
        evil: 'x',
        search: '  batman  '
    });
    assert.deepEqual(cleaned, {
        genre: 'drama',
        search: 'batman',
        jump: 'start'
    });
    // Non-required enum without a value stays absent.
    assert.deepEqual(sanitizeExtra(descriptor, {}), { jump: 'start' });
});
