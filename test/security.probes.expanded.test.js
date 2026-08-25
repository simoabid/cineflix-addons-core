/**
 * Phase 9 §12.1 — expanded adversarial security probes.
 *
 * Complements security.probes.test.js with the remaining automated checks
 * from the plan: reverse-proxy identity spoofing / role escalation, open
 * redirect and host-header reflection, malformed-body handling, admin-UI
 * inline-XSS supply-chain scan, and credential echo through error responses.
 *
 * Zero-dependency: harness-built Fastify apps + node:assert/strict.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp, getJson, devConfig } from './helpers/harness.js';
import { makeAuthGuard, registerAuthRoutes } from '../dist/routes/auth.js';
import { resolveActor } from '../dist/security/auth.js';

// ── reverse-proxy identity trust ─────────────────────────────────────────────

test('x-forwarded-user/role from an untrusted peer never authenticate', async () => {
    const cfg = {
        ...devConfig(),
        authMode: 'reverse-proxy',
        trustedProxyCidrs: [], // no proxies trusted
        proxyUserHeader: 'x-forwarded-user',
        proxyRoleHeader: 'x-forwarded-role'
    };
    const app = await buildApp((a) =>
        a.get(
            '/probe',
            { preHandler: makeAuthGuard(cfg, { role: 'admin' }) },
            async () => ({ ok: true })
        )
    );
    const res = await app.inject({
        method: 'GET',
        url: '/probe',
        headers: {
            'x-forwarded-user': 'attacker',
            'x-forwarded-role': 'admin'
        }
    });
    assert.equal(res.statusCode, 401);
});

test('identity headers are honored only from TRUSTED_PROXY_CIDRS peers', async () => {
    const base = {
        ...devConfig(),
        authMode: 'reverse-proxy',
        proxyUserHeader: 'x-forwarded-user',
        proxyRoleHeader: 'x-forwarded-role'
    };

    // Positive control: loopback is a trusted peer here, identity accepted,
    // but an attacker-injected admin role still maps through parseRole and is
    // taken at face value ONLY because this peer is genuinely trusted.
    const trusted = {
        ...base,
        trustedProxyCidrs: ['127.0.0.1/32']
    };
    const actor = resolveActor(
        {
            socket: { remoteAddress: '127.0.0.1' },
            ip: '127.0.0.1',
            headers: {
                'x-forwarded-user': 'proxy-user',
                'x-forwarded-role': 'viewer'
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        },
        trusted
    );
    assert.equal(actor.id, 'proxy-user');
    assert.equal(actor.role, 'viewer');

    // Untrusted peer with identical headers → null.
    const untrusted = { ...base, trustedProxyCidrs: ['10.9.9.0/24'] };
    const none = resolveActor(
        {
            socket: { remoteAddress: '127.0.0.1' },
            ip: '127.0.0.1',
            headers: {
                'x-forwarded-user': 'attacker',
                'x-forwarded-role': 'admin'
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        },
        untrusted
    );
    assert.equal(none, null);
});

test('a session minted as viewer cannot self-escalate via headers', async () => {
    const cfg = {
        ...devConfig(),
        authMode: 'static-token',
        adminToken: 'tok-e2e-escalation-check-1234567890',
        adminTokenRole: 'viewer', // token holder is deliberately low-privilege
        trustedProxyCidrs: []
    };
    const app = await buildApp((a) => {
        a.get(
            '/admin-only',
            { preHandler: makeAuthGuard(cfg, { role: 'admin' }) },
            async () => ({ ok: true })
        );
        a.get(
            '/viewer-ok',
            { preHandler: makeAuthGuard(cfg, { role: 'viewer' }) },
            async () => ({ ok: true })
        );
    });
    const headers = { 'x-admin-token': cfg.adminToken };
    assert.equal(
        (await app.inject({ method: 'GET', url: '/viewer-ok', headers }))
            .statusCode,
        200
    );
    const escalated = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: {
            ...headers,
            // Even with proxy headers presented, static-token mode ignores
            // them entirely — the actor stays the token's fixed role.
            'x-forwarded-role': 'admin',
            'x-forwarded-user': 'someone'
        }
    });
    assert.equal(escalated.statusCode, 403);
});

// ── open redirect / host-header handling ─────────────────────────────────────

test('auth endpoints never redirect off-origin regardless of Host header', async () => {
    const cfg = devConfig();
    const app = await buildApp((a) => registerAuthRoutes(a, cfg));
    const evilHosts = [
        'evil.example',
        '127.0.0.1:9999',
        'metadata.google.internal'
    ];
    for (const host of evilHosts) {
        for (const path of ['/v1/auth/login', '/v1/auth/logout']) {
            const res = await app.inject({
                method: 'POST',
                url: path,
                headers: { host, 'content-type': 'application/json' },
                payload: { token: 'nope' }
            });
            const location = res.headers.location;
            if (location !== undefined) {
                // Any redirect must be relative (path-only), never absolute
                // to an attacker-controlled origin.
                assert.ok(
                    !/^https?:\/\//i.test(location),
                    `${path} redirected to absolute ${location}`
                );
                assert.ok(!location.includes(host));
            }
            assert.ok(res.statusCode < 500);
        }
    }
});

test('error responses never reflect an attacker-supplied Host header', async () => {
    const cfg = {
        ...devConfig(),
        authMode: 'static-token',
        adminToken: 'tok-host-header-probe-1234567890'
    };
    const app = await buildApp((a) =>
        a.get(
            '/probe',
            { preHandler: makeAuthGuard(cfg, { role: 'admin' }) },
            async () => ({ ok: true })
        )
    );
    const res = await app.inject({
        method: 'GET',
        url: '/probe?next=https://evil.example/grab',
        headers: { host: 'evil.example' }
    });
    assert.equal(res.statusCode, 401);
    const body = res.body;
    assert.ok(!body.includes('evil.example'), 'host echoed in error body');
    assert.ok(
        !(res.headers.location ?? '').includes('evil.example'),
        'host echoed in Location'
    );
});

// ── malformed input handling ────────────────────────────────────────────────

test('malformed JSON bodies return 400, never 500', async () => {
    const cfg = devConfig();
    const app = await buildApp((a) => registerAuthRoutes(a, cfg));
    const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{"token": "unterminated'
    });
    assert.equal(res.statusCode, 400);
});

test('wrong-content-type bodies are rejected without crashing', async () => {
    const cfg = {
        ...devConfig(),
        authMode: 'static-token',
        adminToken: 'tok-content-type-probe-123456789'
    };
    const app = await buildApp((a) => registerAuthRoutes(a, cfg));
    const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'text/plain' },
        payload: 'token=whatever'
    });
    // Fastify ≥4.17 parses text/plain to a raw string; the login route then
    // rejects it as an invalid token. All of {400, 401, 415} are safe.
    assert.ok([400, 401, 415].includes(res.statusCode));
});

// ── credential echo ─────────────────────────────────────────────────────────

test('failed logins do not echo the submitted secret back', async () => {
    const SECRET = 'super-secret-token-value-abc123';
    const cfg = {
        ...devConfig(),
        authMode: 'static-token',
        adminToken: 'tok-not-the-submitted-secret-1234'
    };
    const app = await buildApp((a) => registerAuthRoutes(a, cfg));
    const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { token: SECRET }
    });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.body.includes(SECRET), 'token echoed in response body');
    for (const [k, v] of Object.entries(res.headers)) {
        const value = Array.isArray(v) ? v.join(';') : String(v ?? '');
        assert.ok(!value.includes(SECRET), `token leaked via header ${k}`);
    }
});

// ── admin UI inline-XSS supply-chain scan ───────────────────────────────────

test('admin UI ships no inline event handlers or javascript: URLs', async () => {
    const adminDir = path.resolve('./public/admin');
    const html = await readFile(path.join(adminDir, 'index.html'), 'utf8');

    // No inline event handlers (onclick=, onerror=, …) in served markup.
    assert.ok(
        !/\son[a-z]+\s*=\s*["']?/i.test(html),
        'inline on*= handler found in admin index.html'
    );
    // No javascript: URLs anywhere in the markup.
    assert.ok(!/javascript\s*:/i.test(html), 'javascript: URL in admin HTML');

    // Scripts are external files (CSP forbids inline execution).
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(
        (m) => m[1]
    );
    assert.ok(srcs.length >= 1, 'admin loads its script externally');
    for (const src of srcs) {
        assert.ok(!src.startsWith('http'), `remote script tag: ${src}`);
    }

    // The external JS bundle must not construct scripts from strings that
    // could smuggle javascript: URLs (cheap static check).
    const js = await readFile(path.join(adminDir, 'app.js'), 'utf8');
    assert.ok(!/document\.write\s*\(/.test(js), 'document.write in app.js');
});
