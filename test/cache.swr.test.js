import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleWhileRevalidate } from '../dist/cache/swr.js';
import { MemoryLruCache } from '../dist/cache/manager.js';

test('StaleWhileRevalidate returns fresh value, stale on grace period with background refresh', async () => {
    const mem = new MemoryLruCache(100);
    const swr = new StaleWhileRevalidate();

    let fetchCount = 0;
    const fetcher = async () => {
        fetchCount++;
        return `payload-${fetchCount}`;
    };

    // First call: cache miss -> fetch synchronously
    const res1 = await swr.getOrFetch(mem, 'item-1', fetcher, {
        ttlSec: 1, // fresh for 1 second
        swrSec: 2 // stale grace for 2 seconds
    });
    assert.equal(res1.source, 'miss');
    assert.equal(res1.value, 'payload-1');
    assert.equal(fetchCount, 1);

    // Second immediate call: fresh -> return cached
    const res2 = await swr.getOrFetch(mem, 'item-1', fetcher, {
        ttlSec: 1,
        swrSec: 2
    });
    assert.equal(res2.source, 'fresh');
    assert.equal(res2.value, 'payload-1');
    assert.equal(fetchCount, 1);

    // Wait 1.1s so it becomes stale (within SWR grace)
    await new Promise((r) => setTimeout(r, 1100));

    // Third call: stale_swr -> returns stale value immediately, triggers background revalidation
    const res3 = await swr.getOrFetch(mem, 'item-1', fetcher, {
        ttlSec: 1,
        swrSec: 2
    });
    assert.equal(res3.source, 'stale_swr');
    assert.equal(res3.value, 'payload-1');

    // Wait a brief moment for background revalidation to complete
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchCount, 2);

    // Fourth call should now read the fresh revalidated value (fresh)
    const res4 = await swr.getOrFetch(mem, 'item-1', fetcher, {
        ttlSec: 1,
        swrSec: 2
    });
    assert.equal(res4.source, 'fresh');
    assert.equal(res4.value, 'payload-2');
});
