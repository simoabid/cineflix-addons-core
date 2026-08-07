import test from 'node:test';
import assert from 'node:assert/strict';
import {
    redactUrl,
    redactHeaders,
    redactValue,
    redactString,
    maskSecret
} from '../dist/security/redaction.js';

test('redactUrl strips userinfo and sensitive query params', () => {
    const out = redactUrl(
        'https://user:secret@cdn.example/path?token=abc123&quality=1080p&api_key=xyz'
    );
    assert.ok(!out.includes('secret'));
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('xyz'));
    assert.ok(!out.includes('user@'));
    assert.ok(out.includes('REDACTED'));
    assert.ok(out.includes('quality=1080p'));
    assert.ok(out.startsWith('https://cdn.example/'));
});

test('redactUrl handles invalid input safely', () => {
    const out = redactUrl('not a url at all token=supersecretvaluehere');
    assert.equal(typeof out, 'string');
});

test('redactHeaders masks authorization and cookies', () => {
    const out = redactHeaders({
        Authorization: 'Bearer super-secret-token-value',
        Cookie: 'session=abc',
        'Content-Type': 'application/json',
        'x-admin-token': 'admin-secret'
    });
    assert.equal(out.Authorization, '[REDACTED]');
    assert.equal(out.Cookie, '[REDACTED]');
    assert.equal(out['x-admin-token'], '[REDACTED]');
    assert.equal(out['Content-Type'], 'application/json');
});

test('redactValue deep-redacts sensitive object keys', () => {
    const out = redactValue({
        provider: 'realdebrid',
        apiKey: 'rd-secret-key',
        password: 'hunter2',
        nested: { token: 'tok', name: 'ok' },
        url: 'https://x.example/?authKey=leak'
    });
    assert.equal(out.apiKey, '[REDACTED]');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.nested.token, '[REDACTED]');
    assert.equal(out.nested.name, 'ok');
    assert.ok(String(out.url).includes('REDACTED'));
});

test('redactString caps length and redacts bearer tokens', () => {
    const long = 'Bearer ' + 'a'.repeat(40) + ' and more text';
    const out = redactString(long, 80);
    assert.ok(out.includes('[REDACTED]'));
    assert.ok(out.length <= 81);
});

test('maskSecret shows only a short suffix', () => {
    assert.equal(maskSecret(''), '');
    assert.equal(maskSecret('ab'), '****');
    const masked = maskSecret('abcdefghijklmnop');
    assert.ok(masked.endsWith('mnop') || masked.endsWith('op'));
    assert.ok(!masked.includes('abcdefgh'));
});
