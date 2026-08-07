import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyBlockedIp,
    normalizeIpv6,
    assertUrlSyntax,
    validateOutboundUrl,
    UrlPolicyError
} from '../dist/security/urlPolicy.js';

// ── IP classification ────────────────────────────────────────────────────────

test('blocks IPv4 loopback', () => {
    assert.equal(classifyBlockedIp('127.0.0.1'), 'loopback');
    assert.equal(classifyBlockedIp('127.0.0.2'), 'loopback');
});

test('blocks IPv4 private ranges', () => {
    assert.equal(classifyBlockedIp('10.0.0.1'), 'private');
    assert.equal(classifyBlockedIp('192.168.1.1'), 'private');
    assert.equal(classifyBlockedIp('172.16.0.1'), 'private');
    assert.equal(classifyBlockedIp('172.31.255.255'), 'private');
});

test('blocks cloud metadata / link-local', () => {
    assert.equal(classifyBlockedIp('169.254.169.254'), 'link-local');
    assert.equal(classifyBlockedIp('169.254.0.1'), 'link-local');
});

test('blocks CGNAT', () => {
    assert.equal(classifyBlockedIp('100.64.0.1'), 'cgnat');
    assert.equal(classifyBlockedIp('100.127.255.255'), 'cgnat');
});

test('blocks multicast and broadcast', () => {
    assert.equal(classifyBlockedIp('224.0.0.1'), 'multicast');
    assert.equal(classifyBlockedIp('255.255.255.255'), 'broadcast');
});

test('allows public IPv4', () => {
    assert.equal(classifyBlockedIp('8.8.8.8'), null);
    assert.equal(classifyBlockedIp('1.1.1.1'), null);
    assert.equal(classifyBlockedIp('93.184.216.34'), null);
});

test('blocks IPv6 loopback and ULA', () => {
    assert.equal(classifyBlockedIp('::1'), 'loopback');
    assert.equal(classifyBlockedIp('fc00::1'), 'unique-local');
    assert.equal(classifyBlockedIp('fd12:3456:789a::1'), 'unique-local');
});

test('blocks IPv6 link-local and multicast', () => {
    assert.equal(classifyBlockedIp('fe80::1'), 'link-local');
    assert.equal(classifyBlockedIp('ff02::1'), 'multicast');
});

test('blocks IPv4-mapped private addresses', () => {
    assert.equal(classifyBlockedIp('::ffff:127.0.0.1'), 'loopback');
    assert.equal(classifyBlockedIp('::ffff:10.0.0.1'), 'private');
    assert.equal(classifyBlockedIp('::ffff:192.168.0.1'), 'private');
    assert.equal(classifyBlockedIp('::ffff:169.254.169.254'), 'link-local');
});

test('normalizeIpv6 expands compressed forms', () => {
    assert.equal(
        normalizeIpv6('::1'),
        '0000:0000:0000:0000:0000:0000:0000:0001'
    );
    assert.ok(normalizeIpv6('2001:db8::1')?.startsWith('2001:0db8:'));
});

// ── URL syntax policy ────────────────────────────────────────────────────────

test('assertUrlSyntax rejects http by default', () => {
    assert.throws(
        () => assertUrlSyntax('http://example.com/manifest.json'),
        (err) => err instanceof UrlPolicyError && err.code === 'BLOCKED_PROTOCOL'
    );
});

test('assertUrlSyntax allows http when opted in', () => {
    const u = assertUrlSyntax('http://example.com/x', { allowHttp: true });
    assert.equal(u.protocol, 'http:');
});

test('assertUrlSyntax rejects embedded credentials', () => {
    assert.throws(
        () => assertUrlSyntax('https://user:pass@example.com/x'),
        (err) =>
            err instanceof UrlPolicyError && err.code === 'BLOCKED_CREDENTIALS'
    );
});

test('assertUrlSyntax rejects localhost and .local', () => {
    assert.throws(() => assertUrlSyntax('https://localhost/x'));
    assert.throws(() => assertUrlSyntax('https://foo.localhost/x'));
    assert.throws(() => assertUrlSyntax('https://printer.local/x'));
});

test('assertUrlSyntax rejects literal private IPs', () => {
    assert.throws(() => assertUrlSyntax('https://127.0.0.1/x'));
    assert.throws(() => assertUrlSyntax('https://10.0.0.5/secret'));
    assert.throws(() => assertUrlSyntax('https://169.254.169.254/latest/meta-data/'));
    assert.throws(() => assertUrlSyntax('https://[::1]/'));
});

test('assertUrlSyntax rejects control characters and whitespace', () => {
    assert.throws(() => assertUrlSyntax('https://exam ple.com/'));
    assert.throws(() => assertUrlSyntax('https://example.com/\x00'));
});

test('assertUrlSyntax rejects file/ftp/javascript schemes', () => {
    assert.throws(() => assertUrlSyntax('file:///etc/passwd'));
    assert.throws(() => assertUrlSyntax('ftp://example.com/x'));
    assert.throws(() => assertUrlSyntax('javascript:alert(1)'));
});

test('assertUrlSyntax accepts clean https URLs', () => {
    const u = assertUrlSyntax('https://torrentio.strem.fun/manifest.json');
    assert.equal(u.hostname, 'torrentio.strem.fun');
});

// ── DNS-aware validation (mocked lookup) ─────────────────────────────────────

test('validateOutboundUrl rejects DNS that resolves to private IP', async () => {
    await assert.rejects(
        () =>
            validateOutboundUrl('https://evil.example/manifest.json', {
                lookup: async () => ['10.0.0.9']
            }),
        (err) => err instanceof UrlPolicyError && err.code === 'BLOCKED_IP'
    );
});

test('validateOutboundUrl rejects DNS that resolves to metadata IP', async () => {
    await assert.rejects(
        () =>
            validateOutboundUrl('https://meta.example/', {
                lookup: async () => ['169.254.169.254']
            }),
        (err) => err instanceof UrlPolicyError && err.code === 'BLOCKED_IP'
    );
});

test('validateOutboundUrl accepts public DNS results', async () => {
    const v = await validateOutboundUrl('https://cdn.example/stream.mp4', {
        lookup: async () => ['93.184.216.34']
    });
    assert.equal(v.hostname, 'cdn.example');
    assert.deepEqual(v.addresses, ['93.184.216.34']);
    assert.equal(v.pinnedAddress, '93.184.216.34');
});

test('validateOutboundUrl rejects when any resolved address is blocked', async () => {
    await assert.rejects(
        () =>
            validateOutboundUrl('https://mixed.example/', {
                lookup: async () => ['8.8.8.8', '127.0.0.1']
            }),
        (err) => err instanceof UrlPolicyError && err.code === 'BLOCKED_IP'
    );
});

test('host allowlist rejects non-listed hosts', async () => {
    await assert.rejects(
        () =>
            validateOutboundUrl('https://other.example/', {
                hostAllowlist: ['allowed.example'],
                skipDns: true
            }),
        (err) => err instanceof UrlPolicyError && err.code === 'BLOCKED_HOST'
    );
});
