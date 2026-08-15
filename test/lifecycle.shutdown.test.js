import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ReadinessGate,
    ShutdownCoordinator,
    globalReadinessGate
} from '../dist/lifecycle/shutdown.js';

test('ReadinessGate flips once and keeps the first reason', () => {
    const gate = new ReadinessGate();
    assert.equal(gate.isShuttingDown, false);
    assert.equal(gate.reason, null);
    gate.beginShutdown('SIGTERM');
    assert.equal(gate.isShuttingDown, true);
    assert.equal(gate.reason, 'SIGTERM');
    assert.ok(gate.startedAt != null);
    assert.ok(gate.elapsedMs >= 0);
    gate.beginShutdown('SIGINT');
    assert.equal(gate.reason, 'SIGTERM', 'first reason wins');
});

test('global readiness gate is shared state', () => {
    assert.equal(globalReadinessGate.isShuttingDown, false);
});

test('ShutdownCoordinator runs phases in order and reports results', async () => {
    const gate = new ReadinessGate();
    const coord = new ShutdownCoordinator(gate, {
        gracePeriodMs: 5000,
        installSignals: false
    });
    const order = [];
    coord
        .addPhase('first', async () => {
            order.push('first');
        })
        .addPhase('second', async () => {
            order.push('second');
        });

    assert.equal(coord.currentState, 'running');
    await coord.begin('test');
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(coord.currentState, 'completed');
    assert.equal(gate.isShuttingDown, true);
    assert.equal(gate.reason, 'test');

    const results = coord.phaseResults;
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok));
});

test('a failing phase does not stop later phases', async () => {
    const gate = new ReadinessGate();
    const coord = new ShutdownCoordinator(gate, {
        gracePeriodMs: 5000,
        installSignals: false
    });
    const ran = [];
    coord
        .addPhase('explodes', async () => {
            throw new Error('kaboom');
        })
        .addPhase('after', async () => {
            ran.push('after');
        });
    await coord.begin('test');
    assert.deepEqual(ran, ['after']);
    const results = coord.phaseResults;
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, 'kaboom');
    assert.equal(results[1].ok, true);
});

test('a hanging phase is bounded by its per-phase timeout', async () => {
    const gate = new ReadinessGate();
    const coord = new ShutdownCoordinator(gate, {
        gracePeriodMs: 5000,
        installSignals: false
    });
    const ran = [];
    coord
        .addPhase(
            'hangs',
            () =>
                new Promise((resolve) => {
                    // Never resolves on its own; 60ms timeout applies.
                    setTimeout(resolve, 10_000);
                }),
            60
        )
        .addPhase('after', async () => {
            ran.push('after');
        });
    const t0 = Date.now();
    await coord.begin('test');
    const duration = Date.now() - t0;
    assert.ok(
        duration < 2000,
        `shutdown should not wait for the hang (${duration}ms)`
    );
    assert.deepEqual(ran, ['after']);
    assert.match(coord.phaseResults[0].error, /timed out/);
});

test('grace period exhaustion skips remaining phases', async () => {
    const gate = new ReadinessGate();
    // Note: the coordinator clamps the grace period to a 500ms minimum.
    const coord = new ShutdownCoordinator(gate, {
        gracePeriodMs: 500,
        installSignals: false
    });
    const ran = [];
    coord
        .addPhase('slow', () => new Promise((r) => setTimeout(r, 240)))
        .addPhase('slower', () => new Promise((r) => setTimeout(r, 280)))
        // Even if 'never' starts with a millisecond of budget left, its own
        // cap is that remainder — it cannot complete before assertions run.
        .addPhase('never', () =>
            new Promise((r) => setTimeout(r, 500)).then(() => ran.push('never'))
        );
    await coord.begin('test');
    assert.deepEqual(ran, [], 'phases beyond the grace period cannot complete');
    const never = coord.phaseResults.find((r) => r.name === 'never');
    assert.ok(never);
    assert.equal(never.ok, false);
    assert.ok(
        /grace period exhausted|timed out/.test(never.error),
        `unexpected skip reason: ${never.error}`
    );
});

test('begin() twice is a no-op', async () => {
    const gate = new ReadinessGate();
    const coord = new ShutdownCoordinator(gate, {
        gracePeriodMs: 1000,
        installSignals: false
    });
    let count = 0;
    coord.addPhase('once', async () => {
        count++;
    });
    await coord.begin('first');
    await coord.begin('second');
    assert.equal(count, 1);
    assert.equal(gate.reason, 'first');
});
