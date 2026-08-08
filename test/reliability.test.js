import test from 'node:test';
import assert from 'node:assert/strict';
import { ReliabilityRegistry } from '../dist/reliability/circuit.js';

test('circuit opens after threshold and half-opens after ttl', async () => {
    const rel = new ReliabilityRegistry({ failureThreshold: 2, openTtlMs: 50 });
    assert.equal(rel.getState('addon:x'), 'closed');
    rel.recordFailure('addon:x', 'timeout');
    assert.equal(rel.getState('addon:x'), 'closed');
    rel.recordFailure('addon:x', 'timeout');
    assert.equal(rel.getState('addon:x'), 'open');
    // Still open before ttl
    assert.equal(rel.getState('addon:x'), 'open');
    await new Promise((r) => setTimeout(r, 60));
    // Should transition to half-open
    assert.equal(rel.getState('addon:x'), 'half-open');
    rel.recordSuccess('addon:x', 100);
    assert.equal(rel.getState('addon:x'), 'closed');
});

test('half-open failure re-opens', async () => {
    const rel = new ReliabilityRegistry({ failureThreshold: 1, openTtlMs: 10 });
    rel.recordFailure('addon:y', 'transport');
    assert.equal(rel.getState('addon:y'), 'open');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(rel.getState('addon:y'), 'half-open');
    rel.recordFailure('addon:y', 'timeout');
    assert.equal(rel.getState('addon:y'), 'open');
});

test('negative cache for no_stream does not open circuit', async () => {
    const rel = new ReliabilityRegistry({ failureThreshold: 2, negativeTtlMs: 50 });
    rel.recordFailure('addon:z', 'no_stream');
    assert.equal(rel.getState('addon:z'), 'closed');
    assert.ok(rel.hasNegative('addon:z', 'no_stream'));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(rel.hasNegative('addon:z', 'no_stream'), false);
});

test('classifyError maps messages to kinds', () => {
    const rel = new ReliabilityRegistry();
    assert.equal(rel.classifyError(new Error('timed out after 5000ms')), 'timeout');
    assert.equal(rel.classifyError(new Error('ENOTFOUND dns')), 'dns');
    assert.equal(rel.classifyError({ status: 404, message: 'http 404' }), 'http_4xx');
    assert.equal(rel.classifyError(new Error('HTTP 503')), 'http_5xx');
    assert.equal(rel.classifyError(new Error('debrid unavailable')), 'debrid_unavailable');
    assert.equal(rel.classifyError(new Error('random transport failure')), 'transport');
});

test('isRetryable only for transient kinds', () => {
    const rel = new ReliabilityRegistry();
    assert.equal(rel.isRetryable('timeout'), true);
    assert.equal(rel.isRetryable('transport'), true);
    assert.equal(rel.isRetryable('http_5xx'), true);
    assert.equal(rel.isRetryable('dns'), true);
    assert.equal(rel.isRetryable('http_4xx'), false);
    assert.equal(rel.isRetryable('no_stream'), false);
    assert.equal(rel.isRetryable('malformed'), false);
});

test('concurrency semaphore limits parallel', async () => {
    const rel = new ReliabilityRegistry({ concurrencyLimit: 1 });
    let concurrent = 0;
    let max = 0;
    const task = async () => {
        const release = await rel.acquire('addon:c');
        concurrent++;
        max = Math.max(max, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        release();
    };
    await Promise.all([task(), task(), task()]);
    assert.equal(max, 1);
});

test('withRetry retries transient and gives up on non-retryable', async () => {
    const rel = new ReliabilityRegistry();
    let attempts = 0;
    const transient = async () => {
        attempts++;
        if (attempts < 3) throw new Error('timeout');
        return 'ok';
    };
    const res = await rel.withRetry(transient, { maxAttempts: 3, baseMs: 5 });
    assert.equal(res, 'ok');
    assert.equal(attempts, 3);

    // Non-retryable should not retry
    attempts = 0;
    const permanent = async () => {
        attempts++;
        const e = new Error('http 404 not found');
        e.status = 404;
        throw e;
    };
    await assert.rejects(() => rel.withRetry(permanent, { maxAttempts: 3, baseMs: 5 }));
    // For http_4xx, classifyError should give http_4xx which is not retryable => only 1 attempt
    assert.equal(attempts, 1);
});

test('metrics snapshot accumulates', () => {
    const rel = new ReliabilityRegistry();
    rel.recordSuccess('addon:m', 100);
    rel.recordSuccess('addon:m', 200);
    rel.recordFailure('addon:m', 'timeout', 50);
    const m = rel.getMetrics('addon:m');
    assert.equal(m.attempts, 3);
    assert.equal(m.successes, 2);
    assert.equal(m.failures, 1);
    assert.ok(m.avgLatency > 0);
    const snap = rel.snapshot();
    assert.ok(snap['addon:m']);
    assert.equal(snap['addon:m'].state, 'closed');
});
