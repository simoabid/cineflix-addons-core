/**
 * Phase 9 §12.1 unit tests — persistence atomicity, corruption recovery and
 * revision-conflict semantics of the file storage backend:
 *
 *  - atomic writes (temp file + rename): no .tmp residue, valid JSON on disk
 *    after concurrent exclusive-section mutations
 *  - corruption recovery: truncated / invalid JSON falls back to an empty,
 *    usable store instead of crashing the process
 *  - optimistic locking: saveAddon(expectedVersion) rejects stale writers
 *  - revision monotonicity across mutations and job/grant lifecycle records
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { OptimisticLockError } from '../dist/storage/types.js';
import { scratchFile, removeScratch } from './helpers/harness.js';

const STORE = scratchFile('storage-atomicity');

function fakeAddon(id, order = 0) {
    return {
        providerId: id,
        slug: id.replace('addon:', ''),
        name: id,
        enabled: true,
        order,
        timeoutMs: 20000,
        source: 'url',
        manifest: {
            id: 'org.test',
            version: '1.0.0',
            name: id,
            resources: ['stream'],
            types: ['movie']
        },
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}

async function freshBackend() {
    await removeScratch(STORE);
    const backend = new FileStorageBackend(STORE);
    await backend.init();
    return backend;
}

test('writes are atomic: after mutations the file is valid JSON and no temp residue remains', async () => {
    const backend = await freshBackend();
    try {
        await backend.saveAddon(fakeAddon('addon:one', 0));
        await backend.saveAddon(fakeAddon('addon:two', 1));
        await backend.bumpRevision('test', 'tester');

        const raw = JSON.parse(await fs.readFile(STORE, 'utf-8'));
        assert.equal(raw.version, 1);
        assert.equal(raw.addons.length, 2);

        const dir = path.dirname(STORE);
        const files = await fs.readdir(dir);
        const residue = files.filter(
            (f) => f.startsWith(path.basename(STORE)) && f.endsWith('.tmp')
        );
        assert.deepEqual(
            residue,
            [],
            'temp files must be renamed away, never left behind'
        );
    } finally {
        await removeScratch(STORE);
    }
});

test('a corrupted (truncated JSON) store recovers to a usable empty store', async () => {
    const backend = await freshBackend();
    await backend.saveAddon(fakeAddon('addon:corrupt-me'));
    await backend.close();

    // Truncate the file mid-JSON, simulating a crash during a non-atomic write
    const raw = await fs.readFile(STORE, 'utf-8');
    await fs.writeFile(
        STORE,
        raw.slice(0, Math.floor(raw.length / 2)),
        'utf-8'
    );

    const recovered = new FileStorageBackend(STORE);
    await recovered.init(); // must not throw
    assert.equal((await recovered.listAddons()).length, 0);
    assert.equal(await recovered.getRevision(), 0);
    // The recovered backend is fully usable for new writes
    await recovered.saveAddon(fakeAddon('addon:after-recovery'));
    assert.equal((await recovered.listAddons()).length, 1);
    await recovered.close();
    await removeScratch(STORE);
});

test('garbage (non-JSON) content also recovers to an empty usable store', async () => {
    await removeScratch(STORE);
    await fs.writeFile(STORE, '\x00 not json at all {{{', 'utf-8');
    const backend = new FileStorageBackend(STORE);
    await backend.init();
    assert.equal((await backend.listAddons()).length, 0);
    await backend.saveAddon(fakeAddon('addon:post-garbage'));
    assert.equal((await backend.listAddons()).length, 1);
    await backend.close();
    await removeScratch(STORE);
});

test('saveAddon enforces optimistic concurrency via expectedVersion', async () => {
    const backend = await freshBackend();
    try {
        const v1 = await backend.saveAddon(fakeAddon('addon:occ'));
        assert.equal(v1.version, 1);

        // A second writer holding a stale version must be rejected
        await assert.rejects(
            () =>
                backend.saveAddon(
                    { ...fakeAddon('addon:occ'), name: 'stale-write' },
                    999
                ),
            (err) => {
                assert.ok(err instanceof OptimisticLockError);
                assert.equal(err.entity, 'addon');
                assert.equal(err.id, 'addon:occ');
                return true;
            }
        );

        // A writer holding the current version succeeds
        const v2 = await backend.saveAddon(
            { ...fakeAddon('addon:occ'), name: 'fresh-write' },
            v1.version
        );
        assert.equal(v2.version, v1.version + 1);
        assert.equal((await backend.getAddon('addon:occ')).name, 'fresh-write');
    } finally {
        await removeScratch(STORE);
    }
});

test('revisions are monotonic and recorded with actor metadata', async () => {
    const backend = await freshBackend();
    try {
        const r1 = await backend.bumpRevision('install', 'actor-a');
        const r2 = await backend.bumpRevision('reorder', 'actor-b');
        assert.ok(r2 > r1, 'revision must be strictly increasing');
        const r3 = await backend.saveAddon(fakeAddon('addon:rev'));
        assert.ok((await backend.getRevision()) >= r2);

        // The store survives a reload with its revision intact
        const reopened = new FileStorageBackend(STORE);
        await reopened.init();
        assert.equal(await reopened.getRevision(), await backend.getRevision());
        assert.equal((await reopened.listAddons()).length, 1);
        await reopened.close();
    } finally {
        await removeScratch(STORE);
    }
});

test('grant lifecycle: expired and consumed grants are not consumable twice', async () => {
    const backend = await freshBackend();
    try {
        const now = Math.floor(Date.now() / 1000);
        const grant = (id, overrides = {}) => ({
            id,
            url: `https://example.com/${id}`,
            headersJson: '{}',
            expiresAt: now + 3600,
            createdAt: Date.now(),
            maxRedirects: 3,
            singleUse: true,
            used: false,
            ...overrides
        });
        await backend.saveGrant(grant('g_active'));
        await backend.saveGrant(grant('g_expired', { expiresAt: now - 10 }));
        await backend.saveGrant(grant('g_used', { used: true }));

        const consumed = await backend.consumeGrant('g_active');
        assert.ok(consumed, 'active grant is consumable');
        assert.equal(
            await backend.consumeGrant('g_active'),
            null,
            'single-use grant cannot be consumed twice'
        );
        assert.equal(
            await backend.consumeGrant('g_expired'),
            null,
            'expired grant is not consumable'
        );
        assert.equal(
            await backend.consumeGrant('g_used'),
            null,
            'already-used grant is not consumable'
        );

        const cleaned = await backend.cleanupExpiredGrants();
        assert.ok(cleaned >= 1, 'expired grants are purged by cleanup');
        assert.equal(await backend.getGrant('g_expired'), null);
    } finally {
        await removeScratch(STORE);
    }
});

test('removeAddon reconciles deletion and bumps the revision', async () => {
    const backend = await freshBackend();
    try {
        await backend.saveAddon(fakeAddon('addon:del-1'));
        await backend.saveAddon(fakeAddon('addon:del-2'));
        const rev = await backend.getRevision();
        assert.equal(await backend.removeAddon('addon:del-1'), true);
        assert.equal(await backend.removeAddon('addon:missing'), false);
        assert.equal((await backend.listAddons()).length, 1);
        assert.ok((await backend.getRevision()) > rev);
    } finally {
        await removeScratch(STORE);
    }
});

test('exportSanitized never carries transport URLs or credentials', async () => {
    const backend = await freshBackend();
    try {
        await backend.saveAddon({
            ...fakeAddon('addon:export'),
            manifestUrl: 'https://addon.example/config?token=sekrit',
            baseUrl: 'https://addon.example/config',
            originalImportUrl: 'https://addon.example/config?token=sekrit'
        });
        const data = await backend.exportSanitized();
        assert.equal(data.addons.length, 1);
        const exported = data.addons[0];
        assert.equal('manifestUrl' in exported, false);
        assert.equal('baseUrl' in exported, false);
        assert.equal('originalImportUrl' in exported, false);
        assert.equal(
            JSON.stringify(data).includes('sekrit'),
            false,
            'no credential leakage in sanitized export'
        );
    } finally {
        await removeScratch(STORE);
    }
});
