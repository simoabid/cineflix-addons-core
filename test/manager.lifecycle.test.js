/**
 * Phase 9 §12.1 unit tests — AddonManager lifecycle semantics:
 * locking/serialization, dedupe, reorder, refresh, enable/disable, revision
 * events, registry reconciliation (catalog-only exclusion), provider-id
 * collisions, and secret-bearing URL sealing at rest.
 *
 * Uses a local fake Stremio addon server via the dev-only SSRF exemption.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { AddonManager } from '../dist/addons/manager.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import {
    createFakeRegistry,
    devConfig,
    fakeManifest,
    scratchFile,
    removeScratch,
    startFakeAddonServer,
    startHttpServer
} from './helpers/harness.js';

const STORE = scratchFile('manager-lifecycle');

async function freshManager(cfgOverrides = {}, manifestOverrides) {
    const cfg = devConfig(cfgOverrides);
    const storage = new FileStorageBackend(STORE);
    await storage.init();
    const registry = createFakeRegistry();
    const manager = AddonManager.create(registry, cfg, storage);
    await manager.init();
    return { manager, registry, storage, cfg };
}

test('install adds a stream-capable addon, bumps revision, fires the revision hook, and registers the provider', async () => {
    await removeScratch(STORE);
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.streams' })
    });
    try {
        const revisions = [];
        const { manager, registry } = await freshManager();
        manager.setRevisionHook((rev) => revisions.push(rev));

        const before = manager.getRevision();
        const res = await manager.install(upstream.manifestUrl, 'url');
        assert.equal(res.ok, true, res.error);
        assert.equal(res.updated, undefined);
        assert.ok(res.addon.providerId.startsWith('addon:'));
        assert.equal(manager.getRevision(), before + 1);
        assert.deepEqual(revisions, [before + 1]);
        assert.ok(registry.hasProvider(res.addon.providerId));
        assert.equal(manager.getStreamEnabled().length, 1);
        assert.equal(res.addon.admissionState, 'validated');
        // install defaults to enabled in development (importEnableOnInstall)
        assert.equal(res.addon.enabled, true);
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('catalog-only addons are listed but never registered as stream providers', async () => {
    await removeScratch(STORE);
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({
            id: 'org.test.catalogonly',
            resources: ['catalog', 'meta']
        })
    });
    try {
        const { manager, registry } = await freshManager();
        const res = await manager.install(upstream.manifestUrl, 'url');
        assert.equal(res.ok, true);
        assert.equal(res.addon.capabilities.catalog, true);
        assert.equal(res.addon.capabilities.stream.length, 0);
        assert.equal(
            registry.listProviders().length,
            0,
            'catalog-only addon must not enter the stream waterfall'
        );
        assert.equal(manager.getStreamEnabled().length, 0);
        assert.equal(manager.list().length, 1, 'still visible for management');
        // The persistent findings flag the limited status
        assert.ok(
            res.addon.capabilities.status === 'limited' ||
                res.addon.validationFindings.some(
                    (f) => f.severity === 'warning'
                )
        );
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('re-installing the same URL dedupes into an in-place update without a second addon', async () => {
    await removeScratch(STORE);
    let manifest = fakeManifest({ id: 'org.test.dedupe', name: 'Dedupe v1' });
    const upstream = await startHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
    });
    try {
        const { manager } = await freshManager();
        const url = `${upstream.baseUrl}/manifest.json`;
        const first = await manager.install(url, 'url');
        assert.equal(first.ok, true);

        // Simulate an upstream manifest update between installs (same URL)
        manifest = fakeManifest({ id: 'org.test.dedupe', name: 'Dedupe v2' });
        const second = await manager.install(url, 'url');
        assert.equal(second.ok, true);
        assert.equal(second.updated, true, 'dedupe must update in place');
        assert.equal(manager.list().length, 1);
        assert.equal(manager.list()[0].name, 'Dedupe v2');
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('reorder rewrites order fields, keeps registry insertion order in sync', async () => {
    await removeScratch(STORE);
    const a = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.a' })
    });
    const b = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.b' })
    });
    try {
        const { manager, registry } = await freshManager();
        const ra = await manager.install(a.manifestUrl, 'url');
        const rb = await manager.install(b.manifestUrl, 'url');
        const idA = ra.addon.providerId;
        const idB = rb.addon.providerId;
        assert.deepEqual(manager.orderedEnabledProviderIds(), [idA, idB]);

        await manager.reorder([idB, idA]);
        assert.deepEqual(manager.orderedEnabledProviderIds(), [idB, idA]);
        assert.deepEqual(
            registry.listProviders(),
            [idB, idA],
            'registry order must mirror priority order'
        );
        assert.equal(manager.get(idA).order, 1);
        assert.equal(manager.get(idB).order, 0);
    } finally {
        await a.close();
        await b.close();
        await removeScratch(STORE);
    }
});

test('disable unregisters the provider; re-enable restores it; both bump the revision', async () => {
    await removeScratch(STORE);
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.toggle' })
    });
    try {
        const { manager, registry } = await freshManager();
        const { addon } = await manager.install(upstream.manifestUrl, 'url');
        const revAfterInstall = manager.getRevision();
        assert.ok(registry.hasProvider(addon.providerId));

        const off = await manager.setEnabled(addon.providerId, false);
        assert.equal(off.enabled, false);
        assert.equal(off.admissionState, 'disabled');
        assert.equal(registry.hasProvider(addon.providerId), false);
        assert.equal(manager.getStreamEnabled().length, 0);

        const on = await manager.setEnabled(addon.providerId, true);
        assert.equal(on.enabled, true);
        assert.equal(on.admissionState, 'validated');
        assert.ok(registry.hasProvider(addon.providerId));
        assert.equal(manager.getRevision(), revAfterInstall + 2);
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('setTimeout clamps to the supported range and re-registers the provider', async () => {
    await removeScratch(STORE);
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.timeout' })
    });
    try {
        const { manager, registry } = await freshManager();
        const { addon } = await manager.install(upstream.manifestUrl, 'url');
        const updated = await manager.setTimeout(addon.providerId, 5000);
        assert.equal(updated.timeoutMs, 5000);
        // Out-of-range values clamp to the supported window [1000, 120000]
        await manager.setTimeout(addon.providerId, 5);
        assert.equal(manager.get(addon.providerId).timeoutMs, 1000);
        await manager.setTimeout(addon.providerId, 999_999);
        assert.equal(manager.get(addon.providerId).timeoutMs, 120_000);
        assert.ok(
            registry.hasProvider(addon.providerId),
            'timeout change must not drop the provider'
        );
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('refresh re-installs from the original import URL and updates the cached manifest', async () => {
    await removeScratch(STORE);
    let manifest = fakeManifest({ id: 'org.test.refresh', version: '1.0.0' });
    const upstream = await startHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
    });
    try {
        const { manager } = await freshManager();
        const url = `${upstream.baseUrl}/manifest.json`;
        const { addon } = await manager.install(url, 'url');
        assert.equal(addon.manifest.version, '1.0.0');

        manifest = fakeManifest({ id: 'org.test.refresh', version: '2.0.0' });
        const res = await manager.refresh(addon.providerId);
        assert.equal(res.ok, true, res.error);
        assert.equal(res.updated, true);
        assert.equal(manager.get(addon.providerId).manifest.version, '2.0.0');
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('remove deletes the addon, unregisters the provider and bumps the revision', async () => {
    await removeScratch(STORE);
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.remove' })
    });
    try {
        const { manager, registry } = await freshManager();
        const { addon } = await manager.install(upstream.manifestUrl, 'url');
        const rev = manager.getRevision();
        assert.equal(await manager.remove(addon.providerId), true);
        assert.equal(manager.get(addon.providerId), undefined);
        assert.equal(registry.hasProvider(addon.providerId), false);
        assert.equal(manager.getRevision(), rev + 1);
        assert.equal(await manager.remove('addon:missing'), false);
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});

test('concurrent installs serialize under the manager lock: no lost addons, no lost revisions', async () => {
    await removeScratch(STORE);
    const servers = await Promise.all(
        ['c1', 'c2', 'c3', 'c4'].map((id) =>
            startFakeAddonServer({
                manifest: fakeManifest({ id: `org.test.${id}` })
            })
        )
    );
    try {
        const { manager } = await freshManager();
        const rev0 = manager.getRevision();
        await Promise.all(
            servers.map((s) => manager.install(s.manifestUrl, 'url'))
        );
        assert.equal(manager.list().length, servers.length);
        assert.equal(
            manager.getRevision(),
            rev0 + servers.length,
            'every install must bump the revision exactly once'
        );
        assert.equal(
            new Set(manager.orderedEnabledProviderIds()).size,
            servers.length
        );
    } finally {
        await Promise.all(servers.map((s) => s.close()));
        await removeScratch(STORE);
    }
});

test('provider ids de-collide with a numeric suffix when slugs clash', async () => {
    await removeScratch(STORE);
    const a = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.same' })
    });
    const b = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.same' })
    });
    try {
        const { manager } = await freshManager();
        const r1 = await manager.install(a.manifestUrl, 'url');
        const r2 = await manager.install(
            `${b.baseUrl}/different-config/manifest.json`,
            'url'
        );
        assert.equal(r1.ok && r2.ok, true);
        assert.notEqual(r1.addon.providerId, r2.addon.providerId);
        assert.ok(r2.addon.providerId.startsWith('addon:org-test-same-'));
    } finally {
        await a.close();
        await b.close();
        await removeScratch(STORE);
    }
});

test('policy-violating URLs are rejected before any network call', async () => {
    await removeScratch(STORE);
    const { manager } = await freshManager({
        allowHttpUpstreams: false,
        outboundHostAllowSuffixes: []
    });
    const res = await manager.install('https://localhost/manifest.json', 'url');
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === 'policy_violation'));
    assert.equal(manager.list().length, 0);
    await removeScratch(STORE);
});

test('secret-bearing transport URLs are sealed at rest but stay usable in memory', async () => {
    await removeScratch(STORE);
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.test.secret' })
    });
    try {
        const { manager } = await freshManager();
        const configuredUrl = `${upstream.baseUrl}/manifest.json?token=supersecret123456`;
        const res = await manager.install(configuredUrl, 'url');
        assert.equal(res.ok, true, res.error);

        // In memory: the plain URL with the operator's configuration
        assert.equal(
            manager.get(res.addon.providerId).manifestUrl,
            configuredUrl
        );

        // At rest: the query-bearing URL is AES-GCM sealed
        const raw = JSON.parse(await fs.readFile(STORE, 'utf-8'));
        const stored = raw.addons.find(
            (a) => a.providerId === res.addon.providerId
        );
        assert.ok(
            stored.manifestUrl.startsWith('enc:v1:'),
            'secret-bearing URL must be sealed at rest'
        );
        assert.ok(stored.baseUrl.startsWith('enc:v1:'));

        // And a fresh manager can load it back and unseal it
        const cfg = devConfig();
        const storage2 = new FileStorageBackend(STORE);
        await storage2.init();
        const manager2 = AddonManager.create(
            createFakeRegistry(),
            cfg,
            storage2
        );
        await manager2.init();
        assert.equal(
            manager2.get(res.addon.providerId).manifestUrl,
            configuredUrl
        );
    } finally {
        await upstream.close();
        await removeScratch(STORE);
    }
});
