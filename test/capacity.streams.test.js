import test from 'node:test';
import assert from 'node:assert/strict';
import {
    StreamConcurrencyTracker,
    StreamConcurrencyError
} from '../dist/capacity/streams.js';

function makeTracker(overrides = {}) {
    // No redis config → in-memory counters (single-instance mode).
    return new StreamConcurrencyTracker({
        maxPerIp: 2,
        maxPerUser: 2,
        maxGlobal: 3,
        ...overrides
    });
}

test('per-IP cap rejects the third concurrent stream from one IP', async () => {
    const t = makeTracker();
    const r1 = await t.acquire({ ip: '203.0.113.10' });
    const r2 = await t.acquire({ ip: '203.0.113.10' });
    await assert.rejects(
        () => t.acquire({ ip: '203.0.113.10' }),
        (err) => {
            assert.ok(err instanceof StreamConcurrencyError);
            assert.equal(err.reason, 'per_ip');
            assert.equal(err.code, 'STREAM_LIMIT_EXCEEDED');
            assert.equal(err.limit, 2);
            return true;
        }
    );
    // Releasing frees the slot.
    await r2();
    const r3 = await t.acquire({ ip: '203.0.113.10' });
    await r3();
    await r1();
});

test('per-IP accounting is isolated between IPs', async () => {
    const t = makeTracker();
    const a = await t.acquire({ ip: '203.0.113.1' });
    const b = await t.acquire({ ip: '203.0.113.2' });
    await a();
    await b();
});

test('per-user cap applies across IPs for the same actor', async () => {
    const t = makeTracker({ maxPerUser: 1 });
    const r = await t.acquire({ ip: '203.0.113.1', userId: 'svc-account' });
    await assert.rejects(
        () => t.acquire({ ip: '198.51.100.9', userId: 'svc-account' }),
        (err) => err.reason === 'per_user'
    );
    await r();
    const r2 = await t.acquire({ ip: '198.51.100.9', userId: 'svc-account' });
    await r2();
});

test('global cap applies across identities', async () => {
    const t = makeTracker({ maxPerIp: 10, maxPerUser: 10, maxGlobal: 2 });
    const r1 = await t.acquire({ ip: '203.0.113.1' });
    const r2 = await t.acquire({ ip: '203.0.113.2' });
    await assert.rejects(
        () => t.acquire({ ip: '203.0.113.3' }),
        (err) => err.reason === 'global'
    );
    await r1();
    await r2();
});

test('rejected acquire rolls back partially-reserved counters', async () => {
    const t = makeTracker({ maxPerIp: 1, maxPerUser: 1, maxGlobal: 1 });
    // ip cap (1) ok; user cap (1) ok; then a second user hitting the global
    // cap must not leak the user reservation.
    const r = await t.acquire({ ip: '203.0.113.1', userId: 'u1' });
    await assert.rejects(
        () => t.acquire({ ip: '203.0.113.2', userId: 'u2' }),
        (err) => err.reason === 'global'
    );
    // u2's user counter must have been rolled back: a fresh acquire for u2
    // once capacity frees must succeed.
    await r();
    const r2 = await t.acquire({ ip: '203.0.113.2', userId: 'u2' });
    await r2();
});

test('release is idempotent', async () => {
    const t = makeTracker({ maxGlobal: 1 });
    const r = await t.acquire({ ip: '1.2.3.4' });
    await r();
    await r();
    const r2 = await t.acquire({ ip: '1.2.3.4' });
    await r2();
});

test('gauges reflect active streams and mode is memory without redis', async () => {
    const t = makeTracker();
    assert.equal(t.mode, 'memory');
    const r = await t.acquire({ ip: '203.0.113.7', userId: 'u' });
    assert.equal(t.gauge().activeStreams, 1);
    await r();
    assert.equal(t.gauge().activeStreams, 0);
});

test('zero caps disable that scope', async () => {
    const t = makeTracker({ maxPerIp: 0, maxPerUser: 0, maxGlobal: 0 });
    for (let i = 0; i < 5; i++) {
        const r = await t.acquire({ ip: `10.0.0.${i}` });
        await r();
    }
});
