import test from 'node:test';
import assert from 'node:assert/strict';
import {
    roleAtLeast,
    parseRole,
    safeEqual,
    signServiceJwt,
    verifyServiceJwt,
    signSession,
    verifySession,
    resolveActor,
    makeAuthGuard
} from '../dist/security/auth.js';

test('roleAtLeast ranks viewer < operator < admin', () => {
    assert.equal(roleAtLeast('admin', 'viewer'), true);
    assert.equal(roleAtLeast('admin', 'operator'), true);
    assert.equal(roleAtLeast('operator', 'viewer'), true);
    assert.equal(roleAtLeast('viewer', 'admin'), false);
    assert.equal(roleAtLeast('operator', 'admin'), false);
    assert.equal(roleAtLeast('viewer', 'viewer'), true);
});

test('parseRole falls back safely', () => {
    assert.equal(parseRole('ADMIN'), 'admin');
    assert.equal(parseRole('operator'), 'operator');
    assert.equal(parseRole('nope', 'viewer'), 'viewer');
});

test('safeEqual is constant-time and correct', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'ab'), false);
});

test('service JWT sign/verify round-trip', () => {
    const secret = 'test-service-jwt-secret';
    const token = signServiceJwt(
        { sub: 'svc-1', role: 'operator', ttlSec: 60 },
        secret
    );
    const claims = verifyServiceJwt(token, secret);
    assert.ok(claims);
    assert.equal(claims.sub, 'svc-1');
    assert.equal(claims.role, 'operator');
});

test('service JWT rejects tampering and wrong secret', () => {
    const secret = 'test-service-jwt-secret';
    const token = signServiceJwt({ sub: 'svc-1', role: 'admin' }, secret);
    assert.equal(verifyServiceJwt(token, 'other-secret'), null);
    const parts = token.split('.');
    const tampered = parts[0] + '.' + parts[1] + '.AAAA';
    assert.equal(verifyServiceJwt(tampered, secret), null);
});

test('service JWT rejects expired tokens', () => {
    const secret = 'test-service-jwt-secret';
    const token = signServiceJwt(
        { sub: 'svc-1', role: 'admin', ttlSec: -10 },
        secret
    );
    assert.equal(verifyServiceJwt(token, secret), null);
});

test('session sign/verify round-trip', () => {
    const secret = 'session-secret';
    const { token, expiresAt } = signSession(
        { sub: 'admin-token', role: 'admin', ttlSec: 3600 },
        secret
    );
    assert.ok(expiresAt instanceof Date);
    const claims = verifySession(token, secret);
    assert.ok(claims);
    assert.equal(claims.sub, 'admin-token');
    assert.equal(claims.role, 'admin');
});

test('session rejects bad signature', () => {
    const { token } = signSession(
        { sub: 'x', role: 'viewer' },
        'session-secret'
    );
    assert.equal(verifySession(token, 'wrong'), null);
    assert.equal(verifySession('not.a.token', 'session-secret'), null);
});

function mockRequest(overrides = {}) {
    return {
        headers: {},
        query: {},
        ip: '127.0.0.1',
        cookies: {},
        ...overrides
    };
}

function baseCfg(overrides = {}) {
    return {
        authMode: 'static-token',
        adminToken: 'correct-token',
        adminTokenRole: 'admin',
        authSessionSecret: 'sess',
        serviceJwtSecret: 'jwt-secret',
        proxyUserHeader: 'x-forwarded-user',
        proxyRoleHeader: 'x-forwarded-role',
        trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/8'],
        ...overrides
    };
}

test('resolveActor: disabled mode yields local-dev admin', () => {
    const actor = resolveActor(mockRequest(), baseCfg({ authMode: 'disabled' }));
    assert.ok(actor);
    assert.equal(actor.id, 'local-dev');
    assert.equal(actor.role, 'admin');
    assert.equal(actor.method, 'none');
});

test('resolveActor: static-token accepts header only', () => {
    const ok = resolveActor(
        mockRequest({ headers: { 'x-admin-token': 'correct-token' } }),
        baseCfg()
    );
    assert.ok(ok);
    assert.equal(ok.method, 'static-token');

    const bad = resolveActor(
        mockRequest({ headers: { 'x-admin-token': 'wrong' } }),
        baseCfg()
    );
    assert.equal(bad, null);
});

test('resolveActor: static-token accepts Bearer', () => {
    const actor = resolveActor(
        mockRequest({ headers: { authorization: 'Bearer correct-token' } }),
        baseCfg()
    );
    assert.ok(actor);
    assert.equal(actor.method, 'static-token');
});

test('resolveActor: reverse-proxy reads identity headers', () => {
    const actor = resolveActor(
        mockRequest({
            headers: {
                'x-forwarded-user': 'alice',
                'x-forwarded-role': 'operator'
            },
            socket: { remoteAddress: '127.0.0.1' }
        }),
        baseCfg({ authMode: 'reverse-proxy' })
    );
    assert.ok(actor);
    assert.equal(actor.id, 'alice');
    assert.equal(actor.role, 'operator');
    assert.equal(actor.method, 'reverse-proxy');
});

test('resolveActor: service-jwt verifies signed token', () => {
    const token = signServiceJwt(
        { sub: 'ci-bot', role: 'operator' },
        'jwt-secret'
    );
    const actor = resolveActor(
        mockRequest({ headers: { authorization: `Bearer ${token}` } }),
        baseCfg({ authMode: 'service-jwt' })
    );
    assert.ok(actor);
    assert.equal(actor.id, 'ci-bot');
    assert.equal(actor.role, 'operator');
    assert.equal(actor.method, 'service-jwt');
});

test('makeAuthGuard rejects query-string tokens', async () => {
    const guard = makeAuthGuard(baseCfg({ authMode: 'disabled' }), {
        role: 'admin'
    });
    let status = 0;
    let body = null;
    const reply = {
        code(s) {
            status = s;
            return this;
        },
        async send(b) {
            body = b;
        }
    };
    await guard(mockRequest({ query: { token: 'leaked' } }), reply);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'TOKEN_IN_QUERY_FORBIDDEN');
});

test('makeAuthGuard enforces role hierarchy', async () => {
    const cfg = baseCfg({ authMode: 'disabled' });
    // disabled yields admin actor — operator guard should pass
    const opGuard = makeAuthGuard(cfg, { role: 'operator' });
    let called = false;
    const req = mockRequest();
    const reply = {
        code() {
            return this;
        },
        async send() {
            called = true;
        }
    };
    await opGuard(req, reply);
    assert.equal(called, false);
    assert.ok(req.auth);
    assert.equal(req.auth.actor.role, 'admin');
});

test('makeAuthGuard returns 401 when unauthenticated', async () => {
    const guard = makeAuthGuard(baseCfg(), { role: 'admin' });
    let status = 0;
    const reply = {
        code(s) {
            status = s;
            return this;
        },
        async send() {}
    };
    await guard(mockRequest(), reply);
    assert.equal(status, 401);
});
