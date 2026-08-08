import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaIdentityService, MediaIdentityError } from '../dist/media/mediaIdentity.js';

test('validates TMDB id format', async () => {
    const svc = new MediaIdentityService();
    await assert.rejects(() => svc.resolve('movie', 'abc'), (err) => err instanceof MediaIdentityError && err.code === 'INVALID_TMDB_ID');
    await assert.rejects(() => svc.resolve('movie', ''), (err) => err.code === 'INVALID_TMDB_ID');
    await assert.rejects(() => svc.resolve('movie', '0'), (err) => err.code === 'INVALID_TMDB_ID');
});

test('validates season/episode ranges', async () => {
    const svc = new MediaIdentityService();
    await assert.rejects(() => svc.resolve('tv', '123', 0, 1), (err) => err.code === 'INVALID_SEASON_EPISODE');
    await assert.rejects(() => svc.resolve('tv', '123', 1, 0), (err) => err.code === 'INVALID_SEASON_EPISODE');
    await assert.rejects(() => svc.resolve('tv', '123', 100, 1), (err) => err.code === 'INVALID_SEASON_EPISODE');
    await assert.rejects(() => svc.resolve('tv', '123', 1, 1000), (err) => err.code === 'INVALID_SEASON_EPISODE');
});

test('caches media identity (second call fromCache)', async () => {
    const svc = new MediaIdentityService();
    // Mock TMDB fetch by stubbing global fetch
    const original = global.fetch;
    let calls = 0;
    global.fetch = async (url) => {
        calls++;
        const u = String(url);
        if (u.includes('/movie/603')) {
            return {
                ok: true,
                json: async () => ({ title: 'The Matrix', release_date: '1999-03-31', external_ids: { imdb_id: 'tt0133093' } })
            };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
        process.env.TMDB_API_KEY = 'test-key';
        const a = await svc.resolve('movie', '603');
        assert.equal(a.media.title, 'The Matrix');
        assert.equal(a.fromCache, false);
        const b = await svc.resolve('movie', '603');
        assert.equal(b.fromCache, true);
        assert.equal(calls, 1);
    } finally {
        global.fetch = original;
        svc.clearCache();
        delete process.env.TMDB_API_KEY;
    }
});

test('negative cache for not found short-circuits', async () => {
    const svc = new MediaIdentityService();
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
        calls++;
        return { ok: false, status: 404, json: async () => ({}) };
    };
    process.env.TMDB_API_KEY = 'test-key';
    try {
        await assert.rejects(() => svc.resolve('movie', '9999999'), (err) => err.code === 'TMDB_NOT_FOUND');
        await assert.rejects(() => svc.resolve('movie', '9999999'), (err) => err.code === 'TMDB_NOT_FOUND');
        // second should be from negative cache (no extra fetch)
        assert.equal(calls, 1);
    } finally {
        global.fetch = original;
        svc.clearCache();
        delete process.env.TMDB_API_KEY;
    }
});

test('abort signal propagates', async () => {
    const svc = new MediaIdentityService();
    const original = global.fetch;
    global.fetch = async (_url, { signal }) => {
        // Simulate fetch respecting signal: if already aborted, throw AbortError
        if (signal?.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        }
        // hang
        await new Promise((_, rej) => {
            if (signal) signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                rej(e);
            });
        });
        return { ok: true, json: async () => ({}) };
    };
    process.env.TMDB_API_KEY = 'test-key';
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 10);
        await assert.rejects(() => svc.resolve('movie', '603', undefined, undefined, { signal: ac.signal }), (err) => err.code === 'ABORTED' || err.code === 'TIMEOUT');
    } finally {
        global.fetch = original;
        svc.clearCache();
        delete process.env.TMDB_API_KEY;
    }
});

test('clearCache resets', async () => {
    const svc = new MediaIdentityService();
    const original = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ title: 'X', release_date: '2020-01-01', external_ids: {} }) });
    process.env.TMDB_API_KEY = 'test-key';
    try {
        await svc.resolve('movie', '1');
        assert.ok(svc.cacheSize() > 0);
        svc.clearCache();
        assert.equal(svc.cacheSize(), 0);
    } finally {
        global.fetch = original;
        svc.clearCache();
        delete process.env.TMDB_API_KEY;
    }
});
