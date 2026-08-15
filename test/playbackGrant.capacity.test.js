import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createPlaybackGrantStore,
    GrantCapacityError
} from '../dist/security/playbackGrant.js';

function storeOpts(overrides = {}) {
    return {
        signingSecret: 'a'.repeat(48),
        defaultTtlSec: 3600,
        urlPolicy: {
            allowHttp: false,
            skipDns: false,
            // Force public resolution without real DNS in tests.
            lookup: async () => ['93.184.216.34']
        },
        ...overrides
    };
}

test('grant store enforces the active-grant hard cap', async () => {
    const grants = createPlaybackGrantStore(
        storeOpts({ maxEntries: 10, maxActive: 2 })
    );
    const g1 = await grants.issue({ url: 'https://cdn.example/a.mp4' });
    const g2 = await grants.issue({ url: 'https://cdn.example/b.mp4' });
    assert.ok(g1.id && g2.id);

    await assert.rejects(
        () => grants.issue({ url: 'https://cdn.example/c.mp4' }),
        (err) => {
            assert.ok(err instanceof GrantCapacityError);
            assert.equal(err.code, 'GRANT_CAPACITY_EXCEEDED');
            return true;
        }
    );

    // Revoking frees capacity.
    assert.equal(await grants.revoke(g1.id), true);
    const g3 = await grants.issue({ url: 'https://cdn.example/c.mp4' });
    assert.ok(g3.id);
});

test('expired grants are purged before the cap rejects', async () => {
    const grants = createPlaybackGrantStore(
        storeOpts({ maxEntries: 10, maxActive: 2 })
    );
    await grants.issue({ url: 'https://cdn.example/a.mp4', ttlSec: -10 });
    await grants.issue({ url: 'https://cdn.example/b.mp4', ttlSec: -10 });
    // Both are already expired — issue() purges then admits.
    const g = await grants.issue({ url: 'https://cdn.example/c.mp4' });
    assert.ok(g.id);
});

test('cap defaults to maxEntries (50k) when maxActive is unset', async () => {
    const grants = createPlaybackGrantStore(storeOpts({ maxEntries: 50_000 }));
    const g = await grants.issue({ url: 'https://cdn.example/a.mp4' });
    assert.ok(g.id);
});
