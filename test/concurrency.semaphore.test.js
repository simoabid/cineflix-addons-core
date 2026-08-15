import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WeightedSemaphore,
    SemaphoreFullError,
    SemaphoreTimeoutError
} from '../dist/concurrency/semaphore.js';

test('semaphore admits up to limit and releases slots', async () => {
    const sem = new WeightedSemaphore({ name: 't1', limit: 2, maxQueue: 10 });
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    // Both slots held; a third must queue until one releases.
    let thirdAdmitted = false;
    const third = sem.acquire().then((r) => {
        thirdAdmitted = true;
        return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(thirdAdmitted, false);
    assert.equal(sem.stats().queued, 1);
    r1();
    const r3 = await third;
    assert.equal(thirdAdmitted, true);
    assert.equal(sem.stats().inFlight, 2);
    r2();
    r3();
    assert.equal(sem.stats().inFlight, 0);
});

test('weighted acquisitions consume proportional capacity (FIFO queue)', async () => {
    const sem = new WeightedSemaphore({ name: 't2', limit: 4, maxQueue: 10 });
    // weight 3 of 4 held.
    const releaseHeavy = await sem.acquire({ weight: 3 });
    assert.equal(sem.stats().inFlight, 3);

    // weight 2 cannot fit alongside weight 3 → queues.
    let secondAdmitted = false;
    const second = sem.acquire({ weight: 2 }).then((r) => {
        secondAdmitted = true;
        return r;
    });
    // weight 1 would fit capacity-wise, but the queue is non-empty and
    // admission is FIFO-fair → it queues behind the weight-2 request.
    let smallAdmitted = false;
    const small = sem.acquire({ weight: 1 }).then((r) => {
        smallAdmitted = true;
        return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(secondAdmitted, false);
    assert.equal(smallAdmitted, false);
    assert.equal(sem.stats().queued, 2);

    releaseHeavy();
    // Pump admits everything that now fits: the weight-2 head, then the
    // weight-1 entry behind it (2 + 1 ≤ 4).
    const releaseSecond = await second;
    assert.equal(secondAdmitted, true);
    const releaseSmall = await small;
    assert.equal(smallAdmitted, true);
    assert.equal(sem.stats().inFlight, 3);
    releaseSecond();
    releaseSmall();
    assert.equal(sem.stats().inFlight, 0);
});

test('pump bypasses a non-fitting head when capacity partially frees', async () => {
    // limit 4: hold 3, queue a weight-3 request (head, won't fit until all
    // freed), then a weight-1 request. Releasing 1 unit must admit the
    // weight-1 request even though the weight-3 head still doesn't fit.
    const sem = new WeightedSemaphore({ name: 't2b', limit: 4, maxQueue: 10 });
    // A(2) + B(2) held. Queue C(3) then D(1). Releasing A frees 2 units —
    // the head C needs 3 and does not fit, but D (1) does and is admitted
    // without starving C (which lands once B releases).
    const releaseA = await sem.acquire({ weight: 2 });
    const releaseB = await sem.acquire({ weight: 2 });
    assert.equal(sem.stats().inFlight, 4);

    let cAdmitted = false;
    let dAdmitted = false;
    const c = sem.acquire({ weight: 3 }).then((r) => {
        cAdmitted = true;
        return r;
    });
    const d = sem.acquire({ weight: 1 }).then((r) => {
        dAdmitted = true;
        return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sem.stats().queued, 2);

    releaseA(); // frees 2 units → only D fits
    const releaseD = await d;
    assert.equal(dAdmitted, true, 'smaller queued entry admitted past head');
    assert.equal(cAdmitted, false, 'head still waiting for enough capacity');
    assert.equal(sem.stats().inFlight, 3); // B(2) + D(1)

    releaseB(); // frees 2 more → C (3) now fits
    const releaseC = await c;
    assert.equal(cAdmitted, true, 'head admitted once capacity suffices');
    releaseC();
    releaseD();
    assert.equal(sem.stats().inFlight, 0);
});

test('priority admissions are dequeued ahead of lower priority', async () => {
    const sem = new WeightedSemaphore({ name: 't3', limit: 1, maxQueue: 10 });
    const r1 = await sem.acquire();
    const order = [];
    const low = sem.acquire({ priority: 0 }).then((r) => {
        order.push('low');
        return r;
    });
    const high = sem.acquire({ priority: 10 }).then((r) => {
        order.push('high');
        return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    r1();
    // The high-priority entry is admitted first; releasing it admits the low one.
    const releaseHigh = await high;
    assert.deepEqual(order, ['high']);
    releaseHigh();
    const releaseLow = await low;
    releaseLow();
    assert.deepEqual(order, ['high', 'low']);
});

test('queue depth cap rejects with SemaphoreFullError', async () => {
    const sem = new WeightedSemaphore({ name: 't4', limit: 1, maxQueue: 1 });
    const r1 = await sem.acquire();
    const queued = sem.acquire(); // fills the queue
    await assert.rejects(
        () => sem.acquire(),
        (err) => {
            assert.ok(err instanceof SemaphoreFullError);
            assert.equal(err.code, 'SEMAPHORE_FULL');
            assert.equal(err.pool, 't4');
            return true;
        }
    );
    assert.equal(sem.stats().totalRejectedFull, 1);
    r1();
    const r2 = await queued;
    r2();
});

test('queued acquisition times out with SemaphoreTimeoutError', async () => {
    const sem = new WeightedSemaphore({
        name: 't5',
        limit: 1,
        maxQueue: 10,
        queueTimeoutMs: 50
    });
    const r1 = await sem.acquire();
    await assert.rejects(
        () => sem.acquire(),
        (err) => {
            assert.ok(err instanceof SemaphoreTimeoutError);
            assert.equal(err.code, 'QUEUE_TIMEOUT');
            assert.ok(err.waitedMs >= 40);
            return true;
        }
    );
    assert.equal(sem.stats().totalQueueTimeouts, 1);
    // Queue must be empty after the timeout (entry cleaned up).
    assert.equal(sem.stats().queued, 0);
    r1();
    // Slot is reusable after timeout cleanup.
    const r2 = await sem.acquire();
    r2();
});

test('abort signal rejects a queued acquisition and cleans up', async () => {
    const sem = new WeightedSemaphore({ name: 't6', limit: 1, maxQueue: 10 });
    const r1 = await sem.acquire();
    const ctrl = new AbortController();
    const queued = sem.acquire({ signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await assert.rejects(
        () => queued,
        (err) => err.name === 'AbortError'
    );
    assert.equal(sem.stats().queued, 0);
    assert.equal(sem.stats().totalAborted, 1);
    r1();
});

test('abort signal on already-aborted acquire rejects immediately', async () => {
    const sem = new WeightedSemaphore({ name: 't7', limit: 1 });
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
        () => sem.acquire({ signal: ctrl.signal }),
        (e) => e.name === 'AbortError'
    );
});

test('release is idempotent', async () => {
    const sem = new WeightedSemaphore({ name: 't8', limit: 2 });
    const r = await sem.acquire();
    r();
    r();
    r();
    assert.equal(sem.stats().inFlight, 0);
});

test('withSlot releases on success and on error', async () => {
    const sem = new WeightedSemaphore({ name: 't9', limit: 1 });
    const out = await sem.withSlot(async () => 42);
    assert.equal(out, 42);
    assert.equal(sem.stats().inFlight, 0);

    await assert.rejects(() =>
        sem.withSlot(async () => {
            throw new Error('boom');
        })
    );
    assert.equal(sem.stats().inFlight, 0);
});

test('abortQueued rejects all waiters without touching in-flight', async () => {
    const sem = new WeightedSemaphore({ name: 't10', limit: 1, maxQueue: 10 });
    const r1 = await sem.acquire();
    const waiters = [sem.acquire(), sem.acquire(), sem.acquire()];
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sem.stats().queued, 3);
    const n = sem.abortQueued();
    assert.equal(n, 3);
    for (const w of waiters) {
        await assert.rejects(
            () => w,
            (e) => e.name === 'AbortError'
        );
    }
    assert.equal(sem.stats().inFlight, 1);
    r1();
    assert.equal(sem.stats().inFlight, 0);
});

test('stats counters track admissions', async () => {
    const sem = new WeightedSemaphore({ name: 't11', limit: 2, maxQueue: 10 });
    const r = await sem.acquire();
    const stats = sem.stats();
    assert.equal(stats.totalAdmitted, 1);
    assert.equal(stats.limit, 2);
    assert.equal(stats.name, 't11');
    r();
});
