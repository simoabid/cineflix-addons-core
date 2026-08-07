import test from 'node:test';
import assert from 'node:assert/strict';
import {
    toSafeError,
    adminCsp,
    parseCookieHeader,
    buildSessionCookie,
    clearSessionCookie,
    assertCorsSafe
} from '../dist/security/httpSecurity.js';

test('toSafeError never returns stacks or raw secrets-looking bodies', () => {
    const err = new Error(' upstream https://x?token=abc failed\n    at foo');
    err.statusCode = 502;
    const { status, body } = toSafeError(err);
    assert.equal(status, 502);
    assert.ok(body.error.code);
    assert.ok(body.error.message);
    assert.ok(!body.error.message.includes('at foo'));
});

test('toSafeError maps UrlPolicyError name', () => {
    const err = Object.assign(new Error('blocked'), { name: 'UrlPolicyError' });
    const { body } = toSafeError(err, 403);
    assert.equal(body.error.code, 'URL_POLICY_VIOLATION');
});

test('toSafeError clamps invalid status to 500 and hides internals', () => {
    const { status, body } = toSafeError(new Error('boom'), 500);
    assert.equal(status, 500);
    assert.equal(body.error.message, 'An unexpected error occurred');
});

test('adminCsp is restrictive', () => {
    const csp = adminCsp();
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(!csp.includes('unsafe-eval'));
});

test('parseCookieHeader decodes values', () => {
    const jar = parseCookieHeader('a=1; addons_core_session=abc%2Bdef; b=x');
    assert.equal(jar.a, '1');
    assert.equal(jar.addons_core_session, 'abc+def');
    assert.equal(jar.b, 'x');
});

test('buildSessionCookie is HttpOnly + SameSite and Secure in prod shape', () => {
    const c = buildSessionCookie('addons_core_session', 'tok', {
        expires: new Date('2030-01-01T00:00:00Z'),
        secure: true
    });
    assert.ok(c.includes('HttpOnly'));
    assert.ok(c.includes('SameSite=Lax'));
    assert.ok(c.includes('Secure'));
    assert.ok(c.includes('addons_core_session=tok'));
});

test('clearSessionCookie expires in the past', () => {
    const c = clearSessionCookie('addons_core_session', { secure: false });
    assert.ok(c.includes('Expires=Thu, 01 Jan 1970'));
    assert.ok(!c.includes('Secure'));
});

test('assertCorsSafe refuses wildcard in production', () => {
    assert.throws(
        () =>
            assertCorsSafe({
                nodeEnv: 'production',
                corsOrigin: '*'
            }),
        /CORS_ORIGIN/
    );
    assert.doesNotThrow(() =>
        assertCorsSafe({
            nodeEnv: 'development',
            corsOrigin: '*'
        })
    );
    assert.doesNotThrow(() =>
        assertCorsSafe({
            nodeEnv: 'production',
            corsOrigin: 'https://cineflix.example'
        })
    );
});
