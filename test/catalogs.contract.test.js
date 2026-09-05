/**
 * Catalog passthrough contract test (Phase 12 §15.1).
 *
 * Boots the real compiled server against a catalog-capable fake addon and
 * exercises: descriptor listing, page fetch + normalization, caching
 * (second request served from cache without an upstream hit), extra-param
 * handling, and denial for undeclared catalogs.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { scratchFile, startFakeAddonServer } from './helpers/harness.js';
import { startServer, createClient } from './e2e/helpers/server.js';
import { startFakeTmdb } from './e2e/helpers/fakes.js';

const ADMIN_TOKEN = 'catalog-admin-token-0123456789abcdef';
const DATA_FILE = scratchFile('catalog-contract');

let tmdb;
let addon;
let server;
let client;

const FAKE_METAS = [
    {
        id: 'tt111',
        name: 'Catalog Movie One',
        type: 'movie',
        poster: 'https://img/1.jpg',
        releaseInfo: '2001',
        imdbRating: '7.1'
    },
    {
        id: 'tt222',
        name: 'Catalog Movie Two',
        type: 'movie',
        poster: 'https://img/2.jpg'
    },
    { id: 'tt222', name: 'Duplicate', type: 'movie' }, // deduped
    { id: '', name: 'no id' } // dropped
];

const MANIFEST = {
    id: 'org.catalog.addon',
    version: '1.0.0',
    name: 'Catalog Addon',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'top',
            name: 'Top Movies',
            extra: [
                { name: 'genre', options: ['drama', 'comedy'] },
                { name: 'skip' }
            ]
        }
    ]
};

let catalogHits = 0;

before(async () => {
    tmdb = await startFakeTmdb();
    addon = await startFakeAddonServer({
        manifest: MANIFEST,
        catalogFor: (type, id, u) => {
            catalogHits++;
            if (u.searchParams.get('genre') === 'comedy') {
                return [{ id: 'tt333', name: 'Comedy Pick', type: 'movie' }];
            }
            return FAKE_METAS;
        }
    });
    await fs.rm(DATA_FILE, { force: true });
    server = await startServer({
        dataFile: DATA_FILE,
        env: {
            adminToken: ADMIN_TOKEN,
            tmdbBaseUrl: `${tmdb.baseUrl}/3`,
            extra: { ADDONS_SEED_URLS: addon.manifestUrl }
        }
    });
    client = createClient(server.baseUrl);
    await client.login(ADMIN_TOKEN);
});

after(async () => {
    await server.stop();
    await addon.close();
    await tmdb.close();
});

test('descriptor listing shows the declared catalog', async () => {
    const res = await client.get('/v1/catalogs');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.catalogs));
    const view = res.body.catalogs.find(
        (c) => c.catalogId === 'top' && c.type === 'movie'
    );
    assert.ok(view, 'declared catalog descriptor missing');
    assert.equal(view.addonSlug, 'org-catalog-addon');
    assert.equal(view.name, 'Top Movies');
    assert.ok(res.headers.get('x-provider-revision'));
});

test('catalog page is fetched, normalized, and namespaced', async () => {
    const res = await client.get('/v1/catalogs/org-catalog-addon/movie/top');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    assert.equal(res.body.cached, false);
    const ids = res.body.metas.map((m) => m.metaId);
    assert.deepEqual(ids, ['tt111', 'tt222']); // dup + malformed dropped
    assert.ok(
        res.body.metas.every((m) => m.id.startsWith('addon:org-catalog-addon:'))
    );
    assert.equal(res.body.metas[0].poster, 'https://img/1.jpg');
    assert.ok(catalogHits >= 1);
});

test('second identical request is served from cache without an upstream hit', async () => {
    const hitsBefore = catalogHits;
    const res = await client.get('/v1/catalogs/org-catalog-addon/movie/top');
    assert.equal(res.status, 200);
    assert.equal(res.body.cached, true);
    assert.equal(
        catalogHits,
        hitsBefore,
        'cache miss — upstream was re-fetched'
    );
});

test('extra params filter upstream requests and change the cache key', async () => {
    const res = await client.get(
        '/v1/catalogs/org-catalog-addon/movie/top?genre=comedy'
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.cached, false, 'different extra bag must miss cache');
    assert.deepEqual(
        res.body.metas.map((m) => m.name),
        ['Comedy Pick']
    );
});

test('undeclared catalog returns 404; unknown addon returns 404', async () => {
    const missing = await client.get(
        '/v1/catalogs/org-catalog-addon/movie/nope'
    );
    assert.equal(missing.status, 404);
    const unknown = await client.get(
        '/v1/catalogs/org-does-not-exist/movie/top'
    );
    assert.equal(unknown.status, 404);
});

test('anonymous catalog access is denied', async () => {
    const res = await fetch(`${server.baseUrl}/v1/catalogs`);
    assert.equal(res.status, 401);
});
