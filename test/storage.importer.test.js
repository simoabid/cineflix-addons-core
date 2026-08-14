import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import {
    backupAddonsJson,
    migrateLegacyFileToStorage,
    importSanitizedConfiguration
} from '../dist/storage/importer.js';

const legacyTestFile = path.resolve('./data/test-legacy-addons.json');
const targetStoreFile = path.resolve('./data/test-importer-store.json');

async function cleanupFiles() {
    try { await fs.unlink(legacyTestFile); } catch { /* ignore */ }
    try { await fs.unlink(targetStoreFile); } catch { /* ignore */ }
    // Clean any backup files
    try {
        const dir = path.dirname(legacyTestFile);
        const files = await fs.readdir(dir);
        for (const f of files) {
            if (f.startsWith('test-legacy-addons.json.bak')) {
                await fs.unlink(path.join(dir, f));
            }
        }
    } catch {
        /* ignore */
    }
}

test('importer creates backup and detects sensitive URLs in legacy data', async () => {
    await cleanupFiles();

    const sampleLegacy = {
        version: 1,
        addons: [
            {
                providerId: 'addon:clean',
                slug: 'clean',
                name: 'Clean Addon',
                manifestUrl: 'https://clean.strem.fun/manifest.json',
                baseUrl: 'https://clean.strem.fun',
                enabled: true
            },
            {
                providerId: 'addon:secret',
                slug: 'secret',
                name: 'Secret Addon',
                manifestUrl: 'https://secret.strem.fun/eyJhIjoxMjN9/manifest.json?api_key=secret123#fragment',
                baseUrl: 'https://secret.strem.fun/eyJhIjoxMjN9',
                originalImportUrl: 'https://user:pass@secret.strem.fun/manifest.json?token=xyz',
                enabled: true
            }
        ]
    };

    await fs.writeFile(legacyTestFile, JSON.stringify(sampleLegacy, null, 2), 'utf-8');

    const backend = new FileStorageBackend(targetStoreFile);
    await backend.init();

    const result = await migrateLegacyFileToStorage(legacyTestFile, backend, { backup: true });

    assert.equal(result.migrated, 2);
    assert.ok(result.backedUpTo);
    assert.ok(result.sensitiveUrlsFound > 0);

    // Verify backup exists
    const backupContent = await fs.readFile(result.backedUpTo, 'utf-8');
    assert.ok(backupContent.includes('addon:secret'));

    // Verify storage has migrated data
    const addons = await backend.listAddons();
    assert.equal(addons.length, 2);

    await cleanupFiles();
});

test('exportSanitized and importSanitizedConfiguration work without secrets', async () => {
    await cleanupFiles();
    const backend = new FileStorageBackend(targetStoreFile);
    await backend.init();

    const sanitized = {
        version: 1,
        revision: 5,
        addons: [
            {
                providerId: 'addon:sanitized-1',
                slug: 'sanitized-1',
                name: 'Sanitized 1',
                enabled: true,
                order: 0,
                timeoutMs: 8000,
                source: 'manual',
                manifest: { id: 's1', name: 'Sanitized 1', version: '1.0.0', resources: ['stream'], types: ['movie'], catalogs: [] },
                addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ],
        exportedAt: new Date().toISOString()
    };

    const res = await importSanitizedConfiguration(backend, sanitized);
    assert.equal(res.imported, 1);

    const exported = await backend.exportSanitized();
    assert.equal(exported.addons.length, 1);
    assert.equal(exported.addons[0].name, 'Sanitized 1');
    assert.equal(exported.addons[0].providerId, 'addon:sanitized-1');

    await cleanupFiles();
});
