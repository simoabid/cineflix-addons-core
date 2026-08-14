import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { registerOpenApiRoutes } from '../dist/routes/openapi.routes.js';
import { buildOpenApiSpec, toYaml } from '../dist/openapi/spec.js';
import { loadConfig } from '../dist/config.js';

test('buildOpenApiSpec generates valid OpenAPI 3.1 schema structure', () => {
    const spec = buildOpenApiSpec('http://localhost:3006');

    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.info && spec.info.title);
    assert.ok(spec.paths && typeof spec.paths === 'object');
    assert.ok(spec.components && spec.components.schemas);
    assert.ok(spec.components.securitySchemes);

    // Verify key paths exist
    const paths = Object.keys(spec.paths);
    assert.ok(paths.includes('/v1/movies/{id}'));
    assert.ok(paths.includes('/v1/tv/{id}/seasons/{season}/episodes/{episode}'));
    assert.ok(paths.includes('/v1/providers'));
    assert.ok(paths.includes('/v1/addons'));
    assert.ok(paths.includes('/v1/addons/{providerId}'));
    assert.ok(paths.includes('/health/live'));
    assert.ok(paths.includes('/health/ready'));
    assert.ok(paths.includes('/metrics'));
});

test('toYaml converts JavaScript objects into clean YAML string', () => {
    const sample = {
        openapi: '3.1.0',
        info: {
            title: 'Test API',
            version: '1.0.0'
        },
        tags: ['one', 'two']
    };
    const yaml = toYaml(sample);
    assert.ok(yaml.includes('openapi:'));
    assert.ok(yaml.includes('3.1.0'));
    assert.ok(yaml.includes('Test API'));
    assert.ok(yaml.includes('one'));
});

test('OpenAPI endpoints serve JSON, YAML, and HTML documentation', async () => {
    const cfg = loadConfig();
    const app = fastify();
    registerOpenApiRoutes(app, cfg, 'http://localhost:3006');

    // 1. JSON endpoint
    const resJson = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    assert.equal(resJson.statusCode, 200);
    assert.ok(resJson.headers['content-type'].includes('application/json'));
    const bodyJson = JSON.parse(resJson.body);
    assert.equal(bodyJson.openapi, '3.1.0');

    // 2. YAML endpoint
    const resYaml = await app.inject({ method: 'GET', url: '/v1/openapi.yaml' });
    assert.equal(resYaml.statusCode, 200);
    assert.ok(resYaml.headers['content-type'].includes('yaml'));
    assert.ok(resYaml.body.includes('openapi:'));
    assert.ok(resYaml.body.includes('3.1.0'));

    // 3. Interactive Docs HTML
    const resDocs = await app.inject({ method: 'GET', url: '/v1/docs' });
    assert.equal(resDocs.statusCode, 200);
    assert.ok(resDocs.headers['content-type'].includes('text/html'));
    assert.ok(resDocs.body.includes('SwaggerUIBundle'));
});
