import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createPlaybackGrantStore,
    grantPublicView
} from '../dist/security/playbackGrant.js';
import { UrlPolicyError } from '../dist/security/urlPolicy.js';

function store(overrides = {}) {
    return createPlaybackGrantStore({
        signingSecret: 'test-grant-secret',
        defaultTtlSec: 3600,
        urlPolicy: {
            allowHttp: false,
            skipDns: false,
            // Force public resolution for happy-path hosts
            lookup: async () => ['93.184.216.34'],
            ...overrides.urlPolicy
        },
        ...overrides
    });
}

test('issue creates opaque grant with expiry and proxy URL', async () => {
    const g = store();
    const grant = await g.issue({
        url: 'https://cdn.example/video.mp4',
        headers: { Range: 'bytes=0-1', Authorization: 'should-strip' },
        providerId: 'addon:test'
    });
    assert.ok(grant.id);
    assert.equal(grant.url, 'https://cdn.example/video.mp4');
    assert.equal(grant.providerId, 'addon:test');
    assert.ok(grant.exp > Math.floor(Date.now() / 1000));
    // Authorization must never be stored on the grant
    assert.equal(grant.headers.Authorization, undefined);
    assert.equal(grant.headers.Range, 'bytes=0-1');

    const proxyUrl = g.toProxyUrl(grant, 'https://addons.example');
    assert.equal(
        proxyUrl,
        `https://addons.example/v1/proxy/grant/${grant.id}`
    );
});

test('issue rejects private / localhost upstreams', async () => {
    const g = store({
        urlPolicy: { lookup: async () => ['127.0.0.1'] }
    });
    await assert.rejects(
        () => g.issue({ url: 'https://internal.example/x' }),
        UrlPolicyError
    );
});

test('issue rejects literal metadata IP', async () => {
    const g = store();
    await assert.rejects(
        () => g.issue({ url: 'https://169.254.169.254/latest/meta-data/' }),
        UrlPolicyError
    );
});

test('get returns grant until expiry; missing id is null', async () => {
    const g = store();
    const grant = await g.issue({ url: 'https://cdn.example/a.mp4' });
    const got = await g.get(grant.id);
    assert.ok(got);
    assert.equal(got.id, grant.id);
    assert.equal(await g.get('nope'), null);
});

test('single-use consume marks grant used', async () => {
    const g = store();
    const grant = await g.issue({
        url: 'https://cdn.example/once.mp4',
        singleUse: true
    });
    const first = await g.consume(grant.id);
    assert.ok(first);
    const second = await g.consume(grant.id);
    assert.equal(second, null);
});

test('revoke removes grant', async () => {
    const g = store();
    const grant = await g.issue({ url: 'https://cdn.example/r.mp4' });
    assert.equal(await g.revoke(grant.id), true);
    assert.equal(await g.get(grant.id), null);
});

test('compact signed token verifies and expires', async () => {
    const g = store();
    const grant = await g.issue({ url: 'https://cdn.example/t.mp4' });
    const token = g.signCompact(grant);
    const verified = g.verifySignedToken(token);
    assert.ok(verified);
    assert.equal(verified.id, grant.id);

    assert.equal(g.verifySignedToken('bad.token'), null);
    assert.equal(g.verifySignedToken(token.slice(0, -4) + 'XXXX'), null);
});

test('grantPublicView redacts URL and headers', async () => {
    const g = store();
    const grant = await g.issue({
        url: 'https://cdn.example/path?token=secret',
        headers: { 'X-Api-Key': 'k' }
    });
    // Force a sensitive header through for redaction coverage
    grant.headers.Authorization = 'Bearer x';
    const view = grantPublicView(grant);
    assert.ok(
        String(view.url).includes('REDACTED') ||
            !String(view.url).includes('secret')
    );
    assert.equal(view.headers.Authorization, '[REDACTED]');
    assert.equal(view.id, grant.id);
});

test('short-TTL grant is not returned after expiry', async () => {
    const g = store({ defaultTtlSec: 1 });
    // Issue with ttlSec 0 → already expired on next second; use negative via direct map is hard,
    // so issue with ttl 1 and manipulate by consuming after waiting is flaky.
    // Instead issue and override via get after manual expire simulation:
    const grant = await g.issue({
        url: 'https://cdn.example/exp.mp4',
        ttlSec: -1
    });
    // exp in the past → get should purge
    assert.equal(await g.get(grant.id), null);
});
