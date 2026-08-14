import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingleFlightGroup } from '../dist/cache/singleFlight.js';

test('SingleFlightGroup coalesces concurrent calls with the same key', async () => {
    const flight = new SingleFlightGroup();
    let executionCount = 0;

    const slowOperation = async () => {
        executionCount++;
        await new Promise((r) => setTimeout(r, 40));
        return 'result-123';
    };

    // Trigger 5 concurrent calls with the same key
    const promises = [
        flight.do('media:tt123456', slowOperation),
        flight.do('media:tt123456', slowOperation),
        flight.do('media:tt123456', slowOperation),
        flight.do('media:tt123456', slowOperation),
        flight.do('media:tt123456', slowOperation)
    ];

    const results = await Promise.all(promises);

    // All results must match and slowOperation must only execute once!
    assert.deepEqual(results, [
        'result-123',
        'result-123',
        'result-123',
        'result-123',
        'result-123'
    ]);
    assert.equal(executionCount, 1);

    const m = flight.metrics();
    assert.equal(m.totalExecuted, 1);
    assert.equal(m.totalCoalesced, 4);
    assert.equal(flight.inFlightCount(), 0);
});

test('SingleFlightGroup executes new call after previous promise completes', async () => {
    const flight = new SingleFlightGroup();
    let counter = 0;

    const op = async () => ++counter;

    const res1 = await flight.do('key-a', op);
    const res2 = await flight.do('key-a', op);

    assert.equal(res1, 1);
    assert.equal(res2, 2);
    assert.equal(counter, 2);
});
