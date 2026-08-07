import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOutboundHeaders } from '../dist/security/secureFetch.js';

test('sanitizeOutboundHeaders strips hop-by-hop and client auth', () => {
    const out = sanitizeOutboundHeaders({
        Authorization: 'Bearer x',
        Cookie: 'a=b',
        Connection: 'keep-alive',
        Host: 'evil',
        'X-Forwarded-For': '1.2.3.4',
        'User-Agent': 'addons-core',
        Range: 'bytes=0-1',
        Accept: 'application/json'
    });
    assert.equal(out.Authorization, undefined);
    assert.equal(out.Cookie, undefined);
    assert.equal(out.Connection, undefined);
    assert.equal(out.Host, undefined);
    assert.equal(out['X-Forwarded-For'], undefined);
    assert.equal(out['User-Agent'], 'addons-core');
    assert.equal(out.Range, 'bytes=0-1');
    assert.equal(out.Accept, 'application/json');
});

test('sanitizeOutboundHeaders handles empty input', () => {
    assert.deepEqual(sanitizeOutboundHeaders(undefined), {});
    assert.deepEqual(sanitizeOutboundHeaders({}), {});
});
