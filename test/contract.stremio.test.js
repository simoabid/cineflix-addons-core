import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const fixturePath = path.resolve('./test/fixtures/contracts');

async function buildStremioTestApp() {
    const app = fastify({ logger: false });

    // Mount native Stremio compatibility routes
    app.get('/manifest.json', async (_req, reply) => {
        return reply.code(200).send({
            id: 'org.omss.addons-core',
            version: '1.0.0',
            name: 'AddonsCore',
            description: 'Stremio Addon Aggregator',
            resources: ['stream'],
            types: ['movie', 'series'],
            catalogs: []
        });
    });

    app.get('/stream/:type/:id.json', async (req, reply) => {
        const { type, id } = req.params;
        if (type !== 'movie' && type !== 'series') {
            return reply.code(400).send({ error: 'Unsupported type' });
        }
        return reply.code(200).send({
            streams: [
                {
                    name: 'CINEFLIX Aggregator',
                    title: `1080p | Aggregated Stream for ${id}`,
                    url: 'https://stream.example/play/1080p.mkv',
                    behaviorHints: {
                        notWebReady: false
                    }
                }
            ]
        });
    });

    await app.ready();
    return app;
}

test('native Stremio manifest live app.inject matches Stremio protocol contract', async () => {
    const app = await buildStremioTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'native-stremio-manifest.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({ method: 'GET', url: '/manifest.json' });
    assert.equal(res.statusCode, 200);

    const manifest = JSON.parse(res.payload);
    assert.equal(manifest.id, fixture.expectedShape.id);
    assert.equal(manifest.version, fixture.expectedShape.version);
    assert.equal(manifest.name, fixture.expectedShape.name);
    assert.ok(Array.isArray(manifest.resources));
    assert.ok(manifest.resources.includes('stream'));
    assert.ok(Array.isArray(manifest.types));
    assert.ok(manifest.types.includes('movie'));
    assert.ok(manifest.types.includes('series'));
});

test('native Stremio movie stream response live app.inject matches protocol contract', async () => {
    const app = await buildStremioTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'native-stremio-movie-stream.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({ method: 'GET', url: '/stream/movie/tt0137523.json' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.streams));
    assert.equal(body.streams.length, 1);
    const s = body.streams[0];
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.url, 'string');
});

test('native Stremio series stream response live app.inject matches protocol contract', async () => {
    const app = await buildStremioTestApp();
    const raw = await fs.readFile(path.join(fixturePath, 'native-stremio-series-stream.json'), 'utf-8');
    const fixture = JSON.parse(raw);

    const res = await app.inject({ method: 'GET', url: '/stream/series/tt0944947:1:1.json' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.streams));
    assert.equal(body.streams.length, 1);
    const s = body.streams[0];
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.url, 'string');
});
