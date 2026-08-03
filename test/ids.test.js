import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildIdCandidates,
    toStremioType,
    normalizeImdb,
    manifestSupportsType
} from '../dist/stremio/ids.js';

test('toStremioType maps OMSS types', () => {
    assert.equal(toStremioType('movie'), 'movie');
    assert.equal(toStremioType('tv'), 'series');
});

test('normalizeImdb ensures tt prefix', () => {
    assert.equal(normalizeImdb('0111161'), 'tt0111161');
    assert.equal(normalizeImdb('tt0111161'), 'tt0111161');
});

test('buildIdCandidates: movie prefers imdb, falls back to tmdb', () => {
    const manifest = { id: 'x', name: 'X', idPrefixes: ['tt', 'tmdb'] };
    const media = {
        type: 'movie',
        tmdbId: '603',
        imdbId: 'tt0133093',
        title: 'The Matrix',
        releaseYear: '1999'
    };
    assert.deepEqual(buildIdCandidates(manifest, media), [
        'tt0133093',
        'tmdb:603'
    ]);
});

test('buildIdCandidates: series appends season:episode', () => {
    const manifest = { id: 'x', name: 'X', idPrefixes: ['tt'] };
    const media = {
        type: 'tv',
        tmdbId: '1396',
        imdbId: 'tt0903747',
        title: 'Breaking Bad',
        releaseYear: '2008',
        s: 1,
        e: 2
    };
    assert.deepEqual(buildIdCandidates(manifest, media), ['tt0903747:1:2']);
});

test('buildIdCandidates: no idPrefixes assumes imdb only', () => {
    const manifest = { id: 'x', name: 'X' };
    const media = {
        type: 'movie',
        tmdbId: '603',
        imdbId: 'tt1',
        title: 'x',
        releaseYear: ''
    };
    assert.deepEqual(buildIdCandidates(manifest, media), ['tt1']);
});

test('buildIdCandidates: tmdb-only addon skips imdb', () => {
    const manifest = { id: 'x', name: 'X', idPrefixes: ['tmdb'] };
    const media = {
        type: 'movie',
        tmdbId: '603',
        imdbId: 'tt1',
        title: 'x',
        releaseYear: ''
    };
    assert.deepEqual(buildIdCandidates(manifest, media), ['tmdb:603']);
});

test('manifestSupportsType', () => {
    assert.equal(
        manifestSupportsType({ id: 'x', name: 'X', types: ['movie'] }, 'movie'),
        true
    );
    assert.equal(
        manifestSupportsType({ id: 'x', name: 'X', types: ['movie'] }, 'tv'),
        false
    );
    assert.equal(
        manifestSupportsType({ id: 'x', name: 'X', types: ['series'] }, 'tv'),
        true
    );
    // No declared types → supports anything.
    assert.equal(manifestSupportsType({ id: 'x', name: 'X' }, 'tv'), true);
});
