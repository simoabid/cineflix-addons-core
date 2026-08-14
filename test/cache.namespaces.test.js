import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMediaKey,
    buildProviderResultKey,
    buildAggregateResultKey,
    buildPlaybackGrantKey,
    buildHealthKey,
    buildCircuitKey,
    CacheManager
} from '../dist/cache/index.js';
import { loadConfig } from '../dist/config.js';

test('build standard namespaced cache keys', () => {
    assert.equal(
        buildMediaKey('movie', '550'),
        'media:v1:movie:550:0:0'
    );
    assert.equal(
        buildMediaKey('tv', '1399', 1, 1),
        'media:v1:tv:1399:1:1'
    );
    assert.equal(
        buildProviderResultKey(3, 'media:v1:movie:550:0:0'),
        'provider-result:v1:3:media:v1:movie:550:0:0'
    );
    assert.equal(
        buildAggregateResultKey(7, 'media:v1:movie:550:0:0'),
        'aggregate-result:v1:7:media:v1:movie:550:0:0'
    );
    assert.equal(
        buildPlaybackGrantKey('grant_abc123'),
        'playback-grant:v1:grant_abc123'
    );
    assert.equal(
        buildHealthKey('addon:torrentio'),
        'health:v1:addon:torrentio'
    );
    assert.equal(
        buildCircuitKey('addon:torrentio'),
        'circuit:v1:addon:torrentio'
    );
});

test('CacheManager handles event-driven invalidation', async () => {
    const cfg = loadConfig();
    const cm = new CacheManager(cfg);

    const key1 = buildAggregateResultKey(1, 'media:1');
    const key2 = buildProviderResultKey(1, 'media:1');
    const key3 = buildHealthKey('addon:test');

    await cm.set(key1, { sources: ['s1'] });
    await cm.set(key2, { sources: ['s2'] });
    await cm.set(key3, { healthy: true });

    assert.ok(await cm.get(key1));
    assert.ok(await cm.get(key2));
    assert.ok(await cm.get(key3));

    // Invalidate on revision bump
    await cm.invalidateOnRevisionChange(2);

    assert.equal(await cm.get(key1), null);
    assert.equal(await cm.get(key2), null);
    assert.ok(await cm.get(key3)); // health unaffected
});

test('CacheManager privileged bypass check', () => {
    const cfg = { ...loadConfig(), authMode: 'static-token' };
    const cm = new CacheManager(cfg);

    // Unprivileged user attempting bypass
    const denied = cm.shouldBypass(
        { role: 'viewer' },
        { 'x-cache-bypass': 'true' }
    );
    assert.equal(denied, false);

    // Operator or admin user attempting bypass
    const allowed = cm.shouldBypass(
        { role: 'operator' },
        { 'x-cache-bypass': 'true' }
    );
    assert.equal(allowed, true);

    const allowedAdmin = cm.shouldBypass(
        { role: 'admin' },
        { 'x-cache-bypass': '1' }
    );
    assert.equal(allowedAdmin, true);
});
