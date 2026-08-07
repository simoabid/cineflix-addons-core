import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRateLimiter,
    rateLimitKey,
    RATE_LIMITS
} from '../dist/security/rateLimit.js';

test('rate limiter allows up to limit then blocks', () => {
    const rl = createRateLimiter();
    const key = 'test:actor:ip';
    for (let i = 0; i < 3; i++) {
        const r = rl.take(key, 3, 60_000);
        assert.equal(r.allowed, true);
    }
    const blocked = rl.take(key, 3, 60_000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSec >= 1);
});

test('rate limiter resets per key and via reset()', () => {
    const rl = createRateLimiter();
    rl.take('a', 1, 60_000);
    assert.equal(rl.take('a', 1, 60_000).allowed, false);
    assert.equal(rl.take('b', 1, 60_000).allowed, true);
    rl.reset('a');
    assert.equal(rl.take('a', 1, 60_000).allowed, true);
});

test('rateLimitKey composes bucket/actor/ip', () => {
    assert.equal(rateLimitKey('import', 'admin', '1.2.3.4'), 'import:admin:1.2.3.4');
    assert.equal(rateLimitKey('proxy', undefined, undefined), 'proxy:anon:unknown');
});

test('RATE_LIMITS covers destructive buckets', () => {
    for (const name of ['import', 'remove', 'debrid', 'health', 'auth', 'mutate', 'proxy']) {
        assert.ok(RATE_LIMITS[name]);
        assert.ok(RATE_LIMITS[name].limit > 0);
        assert.ok(RATE_LIMITS[name].windowMs > 0);
    }
});
