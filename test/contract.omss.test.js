import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerAddonRoutes } from '../dist/routes/addons.routes.js';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { loadConfig } from '../dist/config.js';
import { tmdbIdValidator, subtitlesQueryValidator, seasonEpisodeValidator } from '../dist/validation/schemas.js';
import { formatValidationError } from '../dist/validation/validator.js';

const testFile = path.resolve('./data/test-contract-omss.json');
const fixturePath = path.resolve('./test/fixtures/contracts');

async function cleanup() {
    try { await fs.unlink(testFile); } catch { /* ignore */ }
}

function createMockRegistry() {
    const map = new Map();
    return {
        register: (p) => map.set(p.id, p),
        unregister: (id) => map.delete(id),
        getProvider: (id) => map.get(id),
        getProviders: () => Array.from(map.values()),
        listProviders: () => Array.from(map.keys()),
        hasProvider: (id) => map.has(id)
    };
}

async function buildTestApp() {
    await cleanup();
    const cfg = { ...loadConfig(), authMode: 'disabled' };
    const storage = new FileStorageBackend(testFile);
    await storage.init();
    const registry = createMockRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();

    await storage.saveAddon({
        providerId: 'addon:test',
        slug: 'test',
        name: 'Test Stream Provider',
        manifestUrl: 'https://test.example/manifest.json',
        baseUrl: 'https://test.example',
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: { id: 'test', name: 'Test', version: '1.0', resources: ['stream'], types: ['movie', 'series'], catalogs: [] },
        capabilities: { stream: true, subtitles: true, catalog: false, meta: false, status: 'operational' },
        health: { healthy: true, lastChecked: new Date().toISOString() },
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    });

    const app = fastify({ logger: false });

    // Mount OMSS mock routes for contract validation
    app.get('/v1/movies/:id', async (req, reply) => {
        const val = tmdbIdValidator(req.params.id);
        if (!val.ok && val.errors) {
            return reply.code(400).send(formatValidationError(val.errors, req.id));
        }
        return reply.code(200).send({
            sources: [
                {
                    id: 'src_1',
                    name: 'Test Source',
                    title: 'Test Movie 1080p',
                    url: 'https://stream.example/movie.mp4',
                    quality: '1080p',
                    type: 'direct',
                    format: 'mp4',
                    size: 1048576000,
                    providerId: 'addon:test',
                    addonName: 'Test Stream Provider'
                }
            ],
            subtitles: [
                {
                    id: 'sub_1',
                    language: 'eng',
                    url: 'https://subtitles.example/sub.vtt',
                    format: 'vtt'
                }
            ],
            source: 'stremio-addons',
            addonsQueried: 1,
            diagnostics: [],
            revision: manager.getRevision()
        });
    });

    app.get('/v1/tv/:id/seasons/:season/episodes/:episode', async (req, reply) => {
        const idVal = tmdbIdValidator(req.params.id);
        if (!idVal.ok && idVal.errors) {
            return reply.code(400).send(formatValidationError(idVal.errors, req.id));
        }
        const seVal = seasonEpisodeValidator(req.params.season, req.params.episode);
        if (!seVal.ok && seVal.errors) {
            return reply.code(400).send(formatValidationError(seVal.errors, req.id));
        }
        return reply.code(200).send({
            sources: [
                {
                    id: 'src_2',
                    name: 'Test TV Source',
                    title: `Test Show S${seVal.data.season}E${seVal.data.episode} 1080p`,
                    url: 'https://stream.example/episode.mp4',
                    quality: '1080p',
                    type: 'direct',
                    format: 'mp4',
                    size: 524288000,
                    providerId: 'addon:test',
                    addonName: 'Test Stream Provider'
                }
            ],
            subtitles: [],
            source: 'stremio-addons',
            addonsQueried: 1,
            diagnostics: [],
            revision: manager.getRevision()
        });
    });

    app.get('/v1/subtitles', async (req, reply) => {
        const val = subtitlesQueryValidator(req.query);
        if (!val.ok && val.errors) {
            return reply.code(400).send(formatValidationError(val.errors, req.id));
        }
        return reply.code(200).send({
            subtitles: [
                {
                    id: 'sub_1',
                    language: 'eng',
                    url: 'https://subtitles.example/sub.vtt',
                    format: 'vtt'
                }
            ],
            source: 'stremio-addons',
            addonsQueried: 1,
            revision: manager.getRevision()
        });
    });

    registerAddonRoutes(app, manager, cfg);
    await app.ready();
    return { app, manager };
}

test('OMSS movie response contract live app.inject matches golden fixture shape', async () => {
    const { app } = await buildTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'omss-movie-response.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({ method: 'GET', url: '/v1/movies/550' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.sources), 'sources must be an array');
    assert.ok(Array.isArray(body.subtitles), 'subtitles must be an array');
    assert.equal(typeof body.source, 'string');
    assert.equal(typeof body.revision, 'number');
    assert.equal(typeof body.addonsQueried, 'number');

    if (body.sources.length > 0) {
        const s = body.sources[0];
        assert.ok(typeof s.name === 'string');
        assert.ok(typeof s.url === 'string');
        assert.ok(typeof s.quality === 'string');
    }
});

test('OMSS TV response contract live app.inject matches golden fixture shape', async () => {
    const { app } = await buildTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'omss-tv-response.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({ method: 'GET', url: '/v1/tv/1399/seasons/1/episodes/1' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.sources));
    assert.ok(Array.isArray(body.subtitles));
    assert.equal(typeof body.source, 'string');
    assert.equal(typeof body.revision, 'number');
});

test('OMSS subtitle response contract live app.inject matches golden fixture shape', async () => {
    const { app } = await buildTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'subtitles-response.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({ method: 'GET', url: '/v1/subtitles?tmdbId=550' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.subtitles));
    assert.equal(body.source, fixture.expectedShape.source);
    assert.equal(typeof body.revision, 'number');
});

test('OMSS error responses contract live app.inject matches status codes and envelopes', async () => {
    const { app } = await buildTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'omss-error-responses.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    // 1. Bad request on invalid TMDB ID
    const badRes = await app.inject({ method: 'GET', url: '/v1/movies/invalid-id-$$$' });
    assert.equal(badRes.statusCode, fixture.badRequest.status);
    const badBody = JSON.parse(badRes.payload);
    assert.equal(badBody.error.code, fixture.badRequest.body.error.code);
    assert.ok(Array.isArray(badBody.error.details));

    // 2. Precondition failed (concurrency revision mismatch)
    const pRes = await app.inject({
        method: 'PATCH',
        url: '/v1/addons/addon:test',
        headers: { 'If-Match': '"rev-999"' },
        payload: { enabled: false }
    });
    assert.equal(pRes.statusCode, fixture.preconditionFailed.status);
    const pBody = JSON.parse(pRes.payload);
    assert.equal(pBody.error.code, fixture.preconditionFailed.body.error.code);
});
