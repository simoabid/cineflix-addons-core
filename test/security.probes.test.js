/**
 * Phase 9 §12.1 security probes — automated adversarial checks:
 *
 *  - SSRF address classification across IPv4/IPv6/private/CGNAT/NAT64 space,
 *    decimal/hex IP notations, and DNS rebinding (mixed public/private answers)
 *  - Redirect chains revalidated hop-by-hop by secureFetch
 *  - Host-header spoofing grants nothing
 *  - Token/secret leakage: URL redaction matrix, string redaction, audit-log
 *    redaction at rest
 *  - CORS fail-closed rules in production
 *  - Admin CSP hardening (no inline scripts, no object/frame origins)
 */
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
    validateOutboundUrl,
    UrlPolicyError
} from '../dist/security/urlPolicy.js';
import { secureFetch } from '../dist/security/secureFetch.js';
import { redactUrl, redactString } from '../dist/security/redaction.js';
import { createAuditLogger } from '../dist/security/audit.js';
import { assertCorsSafe } from '../dist/security/httpSecurity.js';
import { adminCsp } from '../dist/security/httpSecurity.js';
import {
    scratchFile,
    removeScratch,
    startHttpServer,
    devConfig
} from './helpers/harness.js';

const BASE_POLICY = { allowHttp: true, allowCredentials: false };

// ── SSRF address classification ──────────────────────────────────────────────

async function assertBlocked(host, why) {
    try {
        await validateOutboundUrl(`https://${host}/x`, BASE_POLICY);
        assert.fail(`expected ${host} to be blocked (${why})`);
    } catch (err) {
        assert.ok(err instanceof UrlPolicyError, `${host}: ${err}`);
        assert.notEqual(err.code, 'BLOCKED_PROTOCOL');
    }
}

async function assertAllowed(host) {
    const res = await validateOutboundUrl(`https://${host}/x`, BASE_POLICY);
    assert.ok(res.pinnedAddress || res.hostname, `${host} resolved`);
}

test('IPv4 private, loopback, link-local, CGNAT, metadata and reserved ranges are blocked', async () => {
    const blocked = [
        '127.0.0.1',
        '127.8.8.8',
        '10.0.0.5',
        '10.255.255.255',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.1.1',
        '192.168.0.100',
        '169.254.169.254', // cloud metadata
        '169.254.1.1',
        '100.64.0.1', // CGNAT
        '100.127.255.254',
        '0.0.0.0',
        '192.0.2.10', // TEST-NET-1
        '198.51.100.7', // TEST-NET-2
        '203.0.113.99', // TEST-NET-3
        '224.0.0.1', // multicast
        '255.255.255.255',
        '240.0.0.1' // reserved
    ];
    for (const host of blocked) await assertBlocked(host, 'ipv4 range');
});

test('public IPv4 addresses are allowed', async () => {
    await assertAllowed('8.8.8.8');
    await assertAllowed('1.1.1.1');
    await assertAllowed('93.184.216.34');
});

test('IPv6 loopback, ULA, link-local, multicast and documentation ranges are blocked', async () => {
    const blocked = [
        '::',
        '::1',
        '::1%eth0',
        'fc00::1',
        'fd12:3456:789a::1',
        'fe80::1',
        'fe80::1%en0',
        'ff02::1',
        '2001:db8::1',
        '[::1]',
        '[fe80::1]'
    ];
    for (const host of blocked) await assertBlocked(host, 'ipv6 range');
});

test('IPv4-mapped and NAT64-embedded IPv6 addresses cannot bypass the classifier', async () => {
    const bypass = [
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1',
        '::ffff:169.254.169.254',
        '64:ff9b::127.0.0.1',
        '64:ff9b::192.168.0.1',
        '0064:ff9b::0.0.0.0',
        '::ffff:7f00:1'
    ];
    for (const host of bypass) await assertBlocked(host, 'v6-embedded-v4');
});

test('alternative IP notations (decimal/hex/octal) resolve through DNS and are caught', async () => {
    // '2130706433' == 127.0.0.1 in decimal; '0x7f000001' == 127.0.0.1 in hex.
    // These are hostnames to the URL parser, so the injected lookup simulates
    // what a permissive resolver returns — classification must still block.
    const lookup = async () => ['127.0.0.1'];
    for (const host of ['2130706433', '0x7f000001', '0177.0.0.1']) {
        await assert.rejects(
            validateOutboundUrl(`https://${host}/x`, {
                ...BASE_POLICY,
                lookup
            }),
            (err) => err instanceof UrlPolicyError
        );
    }
});

test('DNS rebinding is neutralized: any private address in the answer set blocks the request', async () => {
    // A resolver that answers public first, private second (classic rebinding
    // for single-answer validators) must still be rejected.
    const rebindingLookup = async () => ['93.184.216.34', '10.0.0.66'];
    await assert.rejects(
        validateOutboundUrl('https://rebind.attacker.example/x', {
            ...BASE_POLICY,
            lookup: rebindingLookup
        }),
        (err) => err instanceof UrlPolicyError
    );

    // All-public answers pass and pin the first address
    const okLookup = async () => ['93.184.216.34', '1.1.1.1'];
    const res = await validateOutboundUrl('https://ok.example/x', {
        ...BASE_POLICY,
        lookup: okLookup
    });
    assert.equal(res.pinnedAddress, '93.184.216.34');
});

test('DNS failure is fail-closed', async () => {
    const failing = async () => {
        throw new Error('ENOTFOUND');
    };
    await assert.rejects(
        validateOutboundUrl('https://nonexistent.example/x', {
            ...BASE_POLICY,
            lookup: failing
        }),
        (err) => err instanceof UrlPolicyError
    );
});

// ── Redirect chains ──────────────────────────────────────────────────────────

test('multi-hop redirect chains are revalidated at every hop', async () => {
    const upstream = await startHttpServer((req, res) => {
        if (req.url === '/hop1') {
            res.writeHead(302, { location: '/hop2' });
            return res.end();
        }
        if (req.url === '/hop2') {
            res.writeHead(302, {
                location: 'https://100.64.1.1/latest/meta-data'
            });
            return res.end();
        }
        if (req.url === '/safe1') {
            res.writeHead(302, { location: '/safe2' });
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
    try {
        // Chain that ends in CGNAT/metadata space — blocked mid-chain
        await assert.rejects(
            () =>
                secureFetch(`${upstream.baseUrl}/hop1`, {
                    policy: { ...BASE_POLICY, allowHostSuffixes: ['127.0.0.1'] }
                }),
            (err) => err instanceof Error
        );

        // Same-origin chain is followed to completion
        const ok = await secureFetch(`${upstream.baseUrl}/safe1`, {
            policy: { ...BASE_POLICY, allowHostSuffixes: ['127.0.0.1'] }
        });
        assert.equal(ok.response.status, 200);
    } finally {
        await upstream.close();
    }
});

// ── Host header / referrer ───────────────────────────────────────────────────

test('a spoofed Host header never authenticates anything by itself', async () => {
    const { buildApp } = await import('./helpers/harness.js');
    const { makeAuthGuard } = await import('../dist/routes/auth.js');
    const cfg = devConfig({
        authMode: 'static-token',
        adminToken: 'real-token-1234567890'
    });
    const app = await buildApp((a) => {
        a.get(
            '/v1/secret',
            { preHandler: makeAuthGuard(cfg, { role: 'admin' }) },
            async () => ({ ok: true })
        );
    });
    try {
        for (const host of ['localhost', 'evil.example', '127.0.0.1:3006']) {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/secret',
                headers: { host, 'x-forwarded-host': 'internal.corp' }
            });
            assert.equal(
                res.statusCode,
                401,
                `host=${host} must not authenticate`
            );
        }
    } finally {
        await app.close();
    }
});

// ── Token / secret leakage ───────────────────────────────────────────────────

test('redactUrl blanks every sensitive query parameter form', () => {
    const cases = [
        ['https://x.example/a?token=abcdef123456', /token=REDACTED/],
        ['https://x.example/a?api_key=abcdef123456', /api_key=REDACTED/],
        ['https://x.example/a?apiKey=abcdef123456', /apiKey=REDACTED/],
        [
            'https://x.example/a?Authorization=Bearer%20xyz',
            /Authorization=REDACTED/
        ],
        ['https://user:pass@x.example/a', null],
        ['https://x.example/a?rd=privatekey123', /rd=REDACTED/]
    ];
    for (const [url, pattern] of cases) {
        const redacted = redactUrl(url);
        if (pattern) assert.match(redacted, pattern, `redacting ${url}`);
        else
            assert.ok(
                !redacted.includes('user:pass'),
                `credentials stripped from ${url}`
            );
    }
    // Non-sensitive params survive
    assert.match(redactUrl('https://x.example/a?page=2&limit=50'), /page=2/);
});

test('redactString scrubs bearer tokens, keys and opaque secrets from free text', () => {
    const leaky =
        'fetched https://api.example/v?apikey=SK123456789 done Bearer eyJhbGciOiJIUzI1NiJ9';
    const safe = redactString(leaky);
    assert.ok(!safe.includes('SK123456789'), 'apikey value scrubbed');
    assert.ok(!safe.includes('eyJhbGciOiJIUzI1NiJ9'), 'bearer token scrubbed');
});

test('audit records are redacted before they touch disk', async () => {
    const file = scratchFile('security-audit-redaction');
    await removeScratch(file);
    const audit = createAuditLogger({ filePath: file, enabled: true });
    await audit.record({
        actor: {
            id: 'operator',
            role: 'operator',
            method: 'static-token',
            ip: '127.0.0.1'
        },
        action: 'settings.patch',
        outcome: 'success',
        details: {
            url: 'https://addon.example/manifest.json?token=topsecret-token-value',
            authorization: 'Bearer super-secret-bearer-value',
            note: 'api_key=abcdef123456 changed'
        }
    });
    const raw = await fs.readFile(file, 'utf-8');
    assert.ok(
        !raw.includes('topsecret-token-value'),
        'token query value must not land in the audit log'
    );
    assert.ok(
        !raw.includes('super-secret-bearer-value'),
        'bearer value must not land in the audit log'
    );
    assert.ok(
        !raw.includes('abcdef123456'),
        'api key must not land in the audit log'
    );
    assert.ok(raw.includes('settings.patch'), 'the event itself is recorded');
    await removeScratch(file);
});

// ── CORS ─────────────────────────────────────────────────────────────────────

test('production CORS refuses wildcards and empty allowlists', async () => {
    const { assertProductionSafe } = await import('../dist/config.js');
    const base = {
        nodeEnv: 'production',
        corsOrigin: ''
    };
    assert.throws(() => assertCorsSafe({ ...base, corsOrigin: '' }));
    assert.throws(() => assertCorsSafe({ ...base, corsOrigin: '*' }));

    // Member-level wildcards are refused by the production fail-closed check
    const prodCfg = {
        nodeEnv: 'production',
        authMode: 'static-token',
        adminToken: 'prod-token-1234567890abcdef',
        publicUrl: 'https://addons.example.com',
        corsOrigin: 'https://app.example.com',
        tmdbApiBaseUrl: 'https://api.themoviedb.org/3',
        secretsMasterKey: randomBytes(32).toString('hex'),
        playbackGrantSecret: randomBytes(32).toString('base64url'),
        cacheType: 'redis',
        secureProxy: true,
        allowLegacyProxy: false,
        allowHttpUpstreams: false,
        auditEnabled: true,
        csrfEnabled: true,
        redis: { host: '127.0.0.1', port: 6379 }
    };
    assert.doesNotThrow(() => assertProductionSafe(prodCfg));
    assert.throws(() => assertProductionSafe({ ...prodCfg, corsOrigin: '' }));
    assert.throws(() => assertProductionSafe({ ...prodCfg, corsOrigin: '*' }));
    assert.throws(() =>
        assertProductionSafe({ ...prodCfg, corsOrigin: 'https://a.com,*' })
    );
    assert.throws(() =>
        assertProductionSafe({
            ...prodCfg,
            corsOrigin: 'https://*.example.com'
        })
    );
});

// ── Admin CSP ────────────────────────────────────────────────────────────────

test('admin CSP forbids inline scripts, object sources and framing', () => {
    const csp = adminCsp();
    assert.match(csp, /default-src 'self'/);
    const scriptSrc = /script-src ([^;]+);/.exec(csp)[1];
    assert.ok(
        !scriptSrc.includes('unsafe-inline'),
        `script-src must not allow inline: ${scriptSrc}`
    );
    assert.ok(!scriptSrc.includes('unsafe-eval'), 'no eval in admin');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'self'/);
});
