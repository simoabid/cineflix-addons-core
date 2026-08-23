/**
 * Phase 9 §12.1 integration tests — TMDB response handling in
 * MediaIdentityService. The TMDB client talks to the real API host, so the
 * network boundary is stubbed at `fetch` (repo convention: duck-typed
 * injection, no third-party mocks) and every payload/behavior is exercised
 * through the real service: success mapping, id validation, 404 taxonomy,
 * invalid JSON, timeouts, and cache behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { globalMediaIdentity } from '../dist/media/mediaIdentity.js';

const TMDB_MOVIE = {
    id: 550,
    title: 'Fight Club',
    release_date: '1999-10-15',
    external_ids: { imdb_id: 'tt0137523' }
};
const TMDB_TV = {
    id: 1399,
    name: 'Game of Thrones',
    first_air_date: '2011-04-17',
    external_ids: { imdb_id: 'tt0944947' }
};

const calls = [];
let fetchImpl = null;

function stubFetch(handler) {
    fetchImpl = handler;
}

const originalFetch = globalThis.fetch;

test.beforeEach(() => {
    process.env.TMDB_API_KEY = 'test-key-123';
    globalMediaIdentity.clearCache();
    calls.length = 0;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return fetchImpl(url, init);
    };
});

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TMDB_API_KEY;
});

test('movie resolution maps TMDB payload to a ProviderMediaObject with IMDb id', async () => {
    stubFetch(() => jsonResponse(200, TMDB_MOVIE));
    const { media, fromCache } = await globalMediaIdentity.resolve(
        'movie',
        '550'
    );
    assert.equal(media.type, 'movie');
    assert.equal(media.tmdbId, '550');
    assert.equal(media.imdbId, 'tt0137523');
    assert.equal(media.title, 'Fight Club');
    assert.equal(media.releaseYear, '1999');
    assert.equal(fromCache, false);
    // The upstream call carries the API key and the external_ids expansion
    assert.match(calls[0].url, /\/3\/movie\/550\?.*api_key=test-key-123/);
    assert.match(calls[0].url, /append_to_response=external_ids/);
});

test('TV resolution is show-level; season/episode ride on the media object', async () => {
    stubFetch(() => jsonResponse(200, TMDB_TV));
    const { media } = await globalMediaIdentity.resolve('tv', '1399', 3, 2);
    assert.equal(media.type, 'tv');
    assert.equal(media.imdbId, 'tt0944947');
    assert.equal(media.s, 3);
    assert.equal(media.e, 2);
    assert.match(calls[0].url, /\/3\/tv\/1399\?.*api_key=test-key-123/);
});

test('a second resolution of the same identity is served from cache without a network call', async () => {
    let count = 0;
    stubFetch(() => {
        count++;
        return jsonResponse(200, TMDB_MOVIE);
    });
    await globalMediaIdentity.resolve('movie', '550');
    const second = await globalMediaIdentity.resolve('movie', '550');
    assert.equal(second.fromCache, true);
    assert.equal(count, 1);
});

test('TMDB 404 maps to the TMDB_NOT_FOUND error taxonomy', async () => {
    stubFetch(() =>
        jsonResponse(404, { status_code: 34, status_message: 'not found' })
    );
    const { media, error } = await globalMediaIdentity.resolveOrSoft(
        'movie',
        '999999'
    );
    assert.equal(media, undefined);
    assert.equal(error.code, 'TMDB_NOT_FOUND');
    assert.equal(error.status, 404);
});

test('invalid JSON from TMDB maps to TMDB_ERROR', async () => {
    stubFetch(
        () =>
            new Response('{{{', {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
    );
    const { error } = await globalMediaIdentity.resolveOrSoft('movie', '550');
    assert.equal(error.code, 'TMDB_ERROR');
});

test('upstream HTTP 503 maps to TMDB_ERROR with the status preserved', async () => {
    stubFetch(() => jsonResponse(503, { error: 'overloaded' }));
    const { error } = await globalMediaIdentity.resolveOrSoft('movie', '550');
    assert.equal(error.code, 'TMDB_ERROR');
    assert.equal(error.status, 502);
});

test('network timeouts map to the TIMEOUT taxonomy', async () => {
    stubFetch(() => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
    });
    const { error } = await globalMediaIdentity.resolveOrSoft('movie', '550');
    assert.equal(error.code, 'TIMEOUT');
});

test('invalid TMDB ids are rejected locally before any network call', async () => {
    stubFetch(() => jsonResponse(200, TMDB_MOVIE));
    const { error } = await globalMediaIdentity.resolveOrSoft(
        'movie',
        'not-a-number'
    );
    assert.equal(error.code, 'INVALID_TMDB_ID');
    assert.equal(calls.length, 0, 'no upstream call for invalid ids');
});

test('missing API key fails fast with TMDB_ERROR', async () => {
    delete process.env.TMDB_API_KEY;
    stubFetch(() => jsonResponse(200, TMDB_MOVIE));
    const { error } = await globalMediaIdentity.resolveOrSoft('movie', '550');
    assert.equal(error.code, 'TMDB_ERROR');
    assert.match(error.message, /not configured/i);
});

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}
