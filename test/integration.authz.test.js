/**
 * Phase 9 §12.1 integration tests — authentication, RBAC and request-hardening
 * through the real HTTP pipeline (registerHttpSecurity + registerAuthRoutes +
 * makeAuthGuard): role matrix, session login, CSRF double-submit, token-in-query
 * rejection, login rate limiting, and body/query/header abuse limits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import { registerHttpSecurity } from '../dist/security/httpSecurity.js';
import { registerAuthRoutes, makeAuthGuard } from '../dist/routes/auth.js';
import { devConfig } from './helpers/harness.js';

const TOKEN = 'integration-admin-token-3216549870';
const SESSION_SECRET = 'integration-session-secret-4567890123';

function authCfg(overrides = {}) {
    return devConfig({
        authMode: 'static-token',
        adminToken: TOKEN,
        authSessionSecret: SESSION_SECRET,
        adminTokenRole: 'admin',
        csrfEnabled: true,
        ...overrides
    });
}

/** App with one guarded route per role tier, mimicking real route wiring. */
async function buildGuardedApp(cfg) {
    const app = fastify({ logger: false });
    registerHttpSecurity(app, cfg);
    registerAuthRoutes(app, cfg);
    app.get(
        '/t/viewer',
        { preHandler: makeAuthGuard(cfg, { role: 'viewer' }) },
        async () => ({ ok: true })
    );
    app.get(
        '/t/operator',
        { preHandler: makeAuthGuard(cfg, { role: 'operator' }) },
        async () => ({ ok: true })
    );
    app.post(
        '/t/operator',
        { preHandler: makeAuthGuard(cfg, { role: 'operator' }) },
        async () => ({ ok: true })
    );
    app.get(
        '/t/admin',
        { preHandler: makeAuthGuard(cfg, { role: 'admin' }) },
        async () => ({ ok: true })
    );
    await app.ready();
    return app;
}

test('role matrix: no token 401, wrong token 401, valid token 200, escalation 403', async () => {
    const app = await buildGuardedApp(authCfg());
    try {
        assert.equal(
            (await app.inject({ method: 'GET', url: '/t/viewer' })).statusCode,
            401
        );
        assert.equal(
            (
                await app.inject({
                    method: 'GET',
                    url: '/t/viewer',
                    headers: { 'x-admin-token': 'wrong-token' }
                })
            ).statusCode,
            401
        );
        const ok = await app.inject({
            method: 'GET',
            url: '/t/admin',
            headers: { 'x-admin-token': TOKEN }
        });
        assert.equal(ok.statusCode, 200);
        assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    } finally {
        await app.close();
    }
});

test('a viewer-role actor cannot reach operator or admin routes', async () => {
    const app = await buildGuardedApp(authCfg({ adminTokenRole: 'viewer' }));
    try {
        const h = { 'x-admin-token': TOKEN };
        assert.equal(
            (await app.inject({ method: 'GET', url: '/t/viewer', headers: h }))
                .statusCode,
            200
        );
        assert.equal(
            (
                await app.inject({
                    method: 'GET',
                    url: '/t/operator',
                    headers: h
                })
            ).statusCode,
            403
        );
        assert.equal(
            (await app.inject({ method: 'GET', url: '/t/admin', headers: h }))
                .statusCode,
            403
        );
        const denied = await app.inject({
            method: 'GET',
            url: '/t/admin',
            headers: h
        });
        assert.equal(JSON.parse(denied.payload).error.code, 'FORBIDDEN');
    } finally {
        await app.close();
    }
});

test('an operator-role actor reaches operator routes but not admin routes', async () => {
    const app = await buildGuardedApp(authCfg({ adminTokenRole: 'operator' }));
    try {
        const h = { 'x-admin-token': TOKEN };
        assert.equal(
            (await app.inject({ method: 'GET', url: '/t/viewer', headers: h }))
                .statusCode,
            200
        );
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: '/t/operator',
                    headers: h
                })
            ).statusCode,
            200
        );
        assert.equal(
            (await app.inject({ method: 'GET', url: '/t/admin', headers: h }))
                .statusCode,
            403
        );
    } finally {
        await app.close();
    }
});

test('Bearer authorization is accepted equivalently to x-admin-token', async () => {
    const app = await buildGuardedApp(authCfg());
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/t/admin',
            headers: { authorization: `Bearer ${TOKEN}` }
        });
        assert.equal(res.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('tokens in query strings are hard-rejected before authentication', async () => {
    const app = await buildGuardedApp(authCfg());
    try {
        const res = await app.inject({
            method: 'GET',
            url: `/t/viewer?token=${encodeURIComponent(TOKEN)}`
        });
        assert.equal(res.statusCode, 400);
        assert.equal(
            JSON.parse(res.payload).error.code,
            'TOKEN_IN_QUERY_FORBIDDEN'
        );
    } finally {
        await app.close();
    }
});

test('session login sets HttpOnly cookies and CSRF; mutations require the double-submit header', async () => {
    const app = await buildGuardedApp(authCfg());
    try {
        const login = await app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            payload: { token: TOKEN }
        });
        assert.equal(login.statusCode, 200);
        const body = JSON.parse(login.payload);
        assert.equal(body.actor.role, 'admin');
        assert.ok(body.csrfToken);

        const setCookies = login.headers['set-cookie'];
        const cookieStr = setCookies.map((c) => c.split(';')[0]).join('; ');
        assert.match(setCookies.join('\n'), /HttpOnly/i);

        // Who am I — session cookie alone is enough for reads
        const me = await app.inject({
            method: 'GET',
            url: '/v1/auth/me',
            headers: { cookie: cookieStr }
        });
        assert.equal(me.statusCode, 200);
        assert.equal(JSON.parse(me.payload).actor.id, 'admin-token');

        // Mutation without the CSRF header → rejected
        const noCsrf = await app.inject({
            method: 'POST',
            url: '/t/operator',
            headers: { cookie: cookieStr }
        });
        assert.equal(noCsrf.statusCode, 403);
        assert.equal(JSON.parse(noCsrf.payload).error.code, 'CSRF_FAILED');

        // Mutation with a mismatched CSRF header → rejected
        const badCsrf = await app.inject({
            method: 'POST',
            url: '/t/operator',
            headers: { cookie: cookieStr, 'x-csrf-token': 'wrong' }
        });
        assert.equal(badCsrf.statusCode, 403);

        // Correct double-submit → allowed
        const withCsrf = await app.inject({
            method: 'POST',
            url: '/t/operator',
            headers: { cookie: cookieStr, 'x-csrf-token': body.csrfToken }
        });
        assert.equal(withCsrf.statusCode, 200);
    } finally {
        await app.close();
    }
});

test('invalid login credentials are rejected and login attempts are rate limited', async () => {
    const app = await buildGuardedApp(authCfg({ adminTokenRole: 'admin' }));
    try {
        const bad = await app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            payload: { token: 'nope' }
        });
        assert.equal(bad.statusCode, 401);

        // RATE_LIMITS.auth = 20/min: hammer until the limiter trips
        let last = null;
        for (let i = 0; i < 25; i++) {
            last = await app.inject({
                method: 'POST',
                url: '/v1/auth/login',
                payload: { token: 'x'.repeat(8) }
            });
            if (last.statusCode === 429) break;
        }
        assert.equal(last.statusCode, 429);
        assert.equal(JSON.parse(last.payload).error.code, 'RATE_LIMITED');
        assert.ok(last.headers['retry-after']);
    } finally {
        await app.close();
    }
});

test('oversized JSON bodies are rejected with 413', async () => {
    const app = await buildGuardedApp(authCfg({ maxBodyBytes: 2048 }));
    try {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: {
                'x-admin-token': TOKEN,
                'content-type': 'application/json'
            },
            payload: { token: 'a'.repeat(8192) }
        });
        assert.equal(res.statusCode, 413);
    } finally {
        await app.close();
    }
});

test('excessively nested JSON is rejected (depth bomb)', async () => {
    const app = await buildGuardedApp(authCfg({ maxJsonDepth: 5 }));
    try {
        let deep = {};
        let node = deep;
        for (let i = 0; i < 30; i++) {
            node.n = {};
            node = node.n;
        }
        const res = await app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: {
                'x-admin-token': TOKEN,
                'content-type': 'application/json'
            },
            payload: deep
        });
        assert.equal(res.statusCode, 400);
        assert.equal(JSON.parse(res.payload).error.code, 'JSON_DEPTH_EXCEEDED');
    } finally {
        await app.close();
    }
});

test('overlong query strings are rejected with 414 before routing', async () => {
    const app = await buildGuardedApp(authCfg({ maxQueryLength: 256 }));
    try {
        const res = await app.inject({
            method: 'GET',
            url: `/t/viewer?q=${'x'.repeat(2048)}`,
            headers: { 'x-admin-token': TOKEN }
        });
        assert.equal(res.statusCode, 414);
        assert.equal(JSON.parse(res.payload).error.code, 'QUERY_TOO_LONG');
    } finally {
        await app.close();
    }
});

test('oversized request headers are rejected with 431', async () => {
    const app = await buildGuardedApp(authCfg({ maxHeaderBytes: 2048 }));
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/t/viewer',
            headers: { 'x-admin-token': TOKEN, 'x-junk': 'y'.repeat(8192) }
        });
        assert.equal(res.statusCode, 431);
        assert.equal(JSON.parse(res.payload).error.code, 'HEADERS_TOO_LARGE');
    } finally {
        await app.close();
    }
});
