/**
 * Phase 9 §12.1 contract tests — OpenAPI 3.1 spec ↔ implementation conformance:
 *
 *  - every $ref in the spec resolves inside components
 *  - every operation documents responses
 *  - bidirectional path/method consistency between the spec and the real
 *    route modules for every module-owned prefix (auth, jobs, addons, import,
 *    settings, quarantine, cache, audit, debrid, openapi/docs)
 *  - live responses honor documented status codes
 *  - live payloads validate against components.schemas where the spec
 *    defines them (mini JSON-Schema subset: type/required/properties/
 *    items/enum/$ref)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { buildOpenApiSpec } from '../dist/openapi/spec.js';
import { registerAddonRoutes } from '../dist/routes/addons.routes.js';
import { registerImportRoutes } from '../dist/routes/import.routes.js';
import { registerJobRoutes } from '../dist/routes/jobs.routes.js';
import { registerAuthRoutes } from '../dist/routes/auth.js';
import { registerOpenApiRoutes } from '../dist/routes/openapi.routes.js';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { JobEngine } from '../dist/jobs/engine.js';
import { createAuditLogger } from '../dist/security/audit.js';
import {
    createFakeRegistry,
    devConfig,
    scratchFile,
    removeScratch
} from './helpers/harness.js';

const STORE = scratchFile('contract-openapi');
const TOKEN = 'contract-openapi-token-1357924680';
const SPEC = buildOpenApiSpec('http://localhost:3006');

/** Path prefixes owned by route modules this test boots. */
const OWNED_PREFIXES = [
    '/v1/auth',
    '/v1/jobs',
    '/v1/addons',
    '/v1/import',
    '/v1/settings',
    '/v1/quarantine',
    '/v1/cache',
    '/v1/audit',
    '/v1/debrid',
    '/v1/openapi',
    '/v1/docs'
];

const isOwned = (p) =>
    OWNED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

// ── spec linting ─────────────────────────────────────────────────────────────

function collectRefs(node, refs = []) {
    if (Array.isArray(node)) {
        for (const item of node) collectRefs(item, refs);
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (k === '$ref' && typeof v === 'string') refs.push(v);
            else collectRefs(v, refs);
        }
    }
    return refs;
}

function resolveRef(ref, spec) {
    if (!ref.startsWith('#/')) return undefined;
    let node = spec;
    for (const part of ref.slice(2).split('/')) {
        node = node?.[part];
        if (node === undefined) return undefined;
    }
    return node;
}

test('every $ref in the OpenAPI spec resolves', () => {
    const refs = collectRefs(SPEC);
    assert.ok(refs.length > 10, 'spec uses component refs');
    for (const ref of refs) {
        assert.ok(
            resolveRef(ref, SPEC) !== undefined,
            `unresolvable $ref: ${ref}`
        );
    }
});

test('every documented operation declares responses', () => {
    for (const [path, pathItem] of Object.entries(SPEC.paths)) {
        for (const [method, op] of Object.entries(pathItem)) {
            if (['get', 'post', 'patch', 'delete', 'put'].includes(method)) {
                assert.ok(
                    op?.responses && Object.keys(op.responses).length > 0,
                    `${method.toUpperCase()} ${path} documents no responses`
                );
            }
        }
    }
});

// ── spec ↔ routes consistency ────────────────────────────────────────────────

/**
 * Record exact { METHOD, url } registrations by wrapping the fastify route
 * registration APIs before modules are mounted — precise and free of the
 * radix-tree pretty-print ambiguity.
 */
function recordRoutes(app) {
    const recorded = new Set();
    const note = (method, url) => {
        // Accept both `:param` and `{param}` spellings, normalizing to `{param}`
        const normalized = String(url)
            .replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')
            .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        recorded.add(`${method.toUpperCase()} ${normalized}`);
    };
    for (const method of [
        'get',
        'post',
        'patch',
        'delete',
        'put',
        'head',
        'options'
    ]) {
        const orig = app[method].bind(app);
        app[method] = (url, ...args) => {
            note(method, url);
            return orig(url, ...args);
        };
    }
    const origRoute = app.route.bind(app);
    app.route = (opts) => {
        const methods = Array.isArray(opts.method)
            ? opts.method
            : [opts.method];
        for (const m of methods) note(m, opts.url);
        return origRoute(opts);
    };
    return recorded;
}

async function buildContractApp() {
    await removeScratch(STORE);
    await removeScratch(`${STORE}.audit.jsonl`);
    const cfg = devConfig({
        authMode: 'static-token',
        adminToken: TOKEN,
        quarantineEnabled: true
    });
    const storage = new FileStorageBackend(STORE);
    await storage.init();
    const manager = AddonManager.create(createFakeRegistry(), cfg, storage);
    await manager.init();
    const engine = new JobEngine(storage, manager, cfg, {
        concurrency: 1,
        pollIntervalMs: 5000
    });
    const audit = createAuditLogger({
        filePath: `${STORE}.audit.jsonl`,
        enabled: true
    });

    const app = fastify({ logger: false });
    const recordedRoutes = recordRoutes(app);
    registerAddonRoutes(app, manager, cfg, undefined, audit);
    registerImportRoutes(app, manager, cfg, undefined, engine);
    registerJobRoutes(app, engine, storage, cfg);
    registerAuthRoutes(app, cfg);
    registerOpenApiRoutes(app, cfg, 'http://localhost:3006');
    await app.ready();
    return { app, manager, storage, engine, cfg, recordedRoutes };
}

test('every module-owned spec path exists on the app with the documented methods', async () => {
    const { app, storage, engine, recordedRoutes } = await buildContractApp();
    try {
        const appRoutes = recordedRoutes;
        const missing = [];
        for (const [path, pathItem] of Object.entries(SPEC.paths)) {
            if (!isOwned(path)) continue;
            for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
                if (!pathItem[method]) continue;
                if (!appRoutes.has(`${method.toUpperCase()} ${path}`)) {
                    missing.push(`${method.toUpperCase()} ${path}`);
                }
            }
        }
        assert.deepEqual(
            missing,
            [],
            'spec documents routes that are not implemented'
        );
    } finally {
        engine.stop();
        await app.close();
        await storage.close();
        await removeScratch(STORE);
    }
});

test('every implemented module-owned route is documented in the spec', async () => {
    const { app, storage, engine, recordedRoutes } = await buildContractApp();
    try {
        const specRoutes = new Set();
        for (const [path, pathItem] of Object.entries(SPEC.paths)) {
            for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
                if (pathItem[method])
                    specRoutes.add(`${method.toUpperCase()} ${path}`);
            }
        }
        const undocumented = [...recordedRoutes].filter((r) => {
            const [method, path] = r.split(' ');
            if (!isOwned(path)) return false;
            // The dual import aliases are documented once; accept either form
            if (specRoutes.has(`${method} ${path}`)) return false;
            // The import routes are registered under both spellings;
            // documentation of either spelling satisfies the contract.
            const alt = path.startsWith('/v1/addons/import/')
                ? path.replace('/v1/addons/import/', '/v1/import/')
                : path.replace('/v1/import/', '/v1/addons/import/');
            if (alt !== path && specRoutes.has(`${method} ${alt}`))
                return false;
            return true;
        });
        assert.deepEqual(
            undocumented,
            [],
            'implemented routes missing from the spec'
        );
    } finally {
        engine.stop();
        await app.close();
        await storage.close();
        await removeScratch(STORE);
    }
});

// ── live response conformance ────────────────────────────────────────────────

/** Minimal JSON-Schema subset validator (type/required/properties/items/enum/$ref). */
function validateSchema(schema, value, spec, path = '$', errors = []) {
    if (schema?.$ref) {
        const resolved = resolveRef(schema.$ref, spec);
        if (!resolved) {
            errors.push(`${path}: unresolvable ref ${schema.$ref}`);
            return errors;
        }
        return validateSchema(resolved, value, spec, path, errors);
    }
    if (!schema) return errors;
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            errors.push(`${path}: expected object`);
            return errors;
        }
        for (const key of schema.required ?? []) {
            if (!(key in value))
                errors.push(`${path}.${key}: required but missing`);
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (key in value)
                validateSchema(sub, value[key], spec, `${path}.${key}`, errors);
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            errors.push(`${path}: expected array`);
            return errors;
        }
        value.forEach((item, i) =>
            validateSchema(schema.items, item, spec, `${path}[${i}]`, errors)
        );
    } else if (schema.type === 'string') {
        if (typeof value !== 'string') errors.push(`${path}: expected string`);
    } else if (schema.type === 'integer' || schema.type === 'number') {
        if (typeof value !== 'number') errors.push(`${path}: expected number`);
    } else if (schema.type === 'boolean') {
        if (typeof value !== 'boolean')
            errors.push(`${path}: expected boolean`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
        errors.push(
            `${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`
        );
    }
    return errors;
}

test('live responses use documented status codes and validate against spec schemas', async () => {
    const { app, storage, engine } = await buildContractApp();
    const auth = { 'x-admin-token': TOKEN };
    try {
        // GET /v1/addons — documented 200; payload matches AddonListResponse
        const addons = await app.inject({
            method: 'GET',
            url: '/v1/addons',
            headers: auth
        });
        assert.equal(addons.statusCode, 200);
        const schemaErrors = validateSchema(
            SPEC.components.schemas.AddonListResponse,
            addons.json(),
            SPEC
        );
        assert.deepEqual(
            schemaErrors,
            [],
            'GET /v1/addons payload violates AddonListResponse'
        );

        // GET /v1/jobs — documented 200
        const jobs = await app.inject({
            method: 'GET',
            url: '/v1/jobs',
            headers: auth
        });
        assert.equal(jobs.statusCode, 200);
        assert.ok(Array.isArray(jobs.json().jobs));

        // POST /v1/jobs — documented 202 (async work)
        const created = await app.inject({
            method: 'POST',
            url: '/v1/jobs',
            headers: { ...auth, 'content-type': 'application/json' },
            payload: { type: 'health-sweep' }
        });
        assert.equal(created.statusCode, 202);

        // Unauthenticated management calls — documented 401
        for (const url of ['/v1/addons', '/v1/jobs', '/v1/audit']) {
            const res = await app.inject({ method: 'GET', url });
            assert.equal(res.statusCode, 401, `GET ${url} without token`);
            assert.equal(res.json().error.code, 'UNAUTHORIZED');
        }

        // Unknown addon — documented 404 with the standard error envelope
        const missing = await app.inject({
            method: 'GET',
            url: '/v1/addons/addon:does-not-exist',
            headers: auth
        });
        assert.equal(missing.statusCode, 404);
        const errSchema =
            SPEC.components.responses.NotFound.content['application/json']
                .schema;
        const errErrors = validateSchema(errSchema, missing.json(), SPEC);
        assert.deepEqual(
            errErrors,
            [],
            '404 body matches the ErrorResponse envelope'
        );

        // Spec is served
        const specRes = await app.inject({
            method: 'GET',
            url: '/v1/openapi.json'
        });
        assert.equal(specRes.statusCode, 200);
        assert.equal(specRes.json().openapi, '3.1.0');
    } finally {
        engine.stop();
        await app.close();
        await storage.close();
        await removeScratch(STORE);
    }
});
