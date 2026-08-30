import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactUrl } from '../security/redaction.js';
import type {
    IStorageBackend,
    AddonRecord,
    SanitizedExportData
} from './types.js';

export interface SensitiveUrlFinding {
    providerId: string;
    field: 'manifestUrl' | 'baseUrl' | 'originalImportUrl';
    rawUrl: string;
    redactedUrl: string;
    reason: string;
}

export interface LegacyMigrationResult {
    backedUpTo?: string;
    migrated: number;
    sensitiveUrlsFound: number;
    sensitiveReports: SensitiveUrlFinding[];
}

function detectSensitiveUrl(
    providerId: string,
    field: SensitiveUrlFinding['field'],
    url: string
): SensitiveUrlFinding | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        const reasons: string[] = [];
        if (u.username || u.password) {
            reasons.push('Contains embedded basic auth credentials');
        }
        if (u.search && u.search.length > 1) {
            for (const key of u.searchParams.keys()) {
                if (/token|key|secret|auth|pass|api|user|sig/i.test(key)) {
                    reasons.push(`Sensitive query parameter found: '${key}'`);
                }
            }
            if (reasons.length === 0) {
                reasons.push('Contains configuration query parameters');
            }
        }
        if (u.hash && u.hash.length > 1) {
            reasons.push('Contains URL fragment data');
        }

        // Check path segments for encoded tokens
        const segments = u.pathname.split('/').filter(Boolean);
        for (const seg of segments) {
            if (
                seg !== 'manifest.json' &&
                seg.length >= 24 &&
                /^[A-Za-z0-9_-]+={0,2}$/.test(seg)
            ) {
                reasons.push('Contains base64/token configured path segment');
                break;
            }
        }

        if (reasons.length > 0) {
            return {
                providerId,
                field,
                rawUrl: url,
                redactedUrl: redactUrl(url),
                reason: reasons.join('; ')
            };
        }
    } catch {
        if (url.includes('?') || url.includes('#')) {
            return {
                providerId,
                field,
                rawUrl: url,
                redactedUrl: redactUrl(url),
                reason: 'Malformed URL with query/fragment components'
            };
        }
    }
    return null;
}

export async function backupAddonsJson(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${resolved}.bak.${ts}`;
    await fs.copyFile(resolved, backupPath);
    return backupPath;
}

export async function migrateLegacyFileToStorage(
    legacyFilePath: string,
    storage: IStorageBackend,
    opts: { backup?: boolean } = { backup: true }
): Promise<LegacyMigrationResult> {
    const resolved = path.resolve(legacyFilePath);
    let backedUpTo: string | undefined;

    try {
        const raw = await fs.readFile(resolved, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.addons)) {
            return {
                migrated: 0,
                sensitiveUrlsFound: 0,
                sensitiveReports: []
            };
        }

        if (opts.backup) {
            backedUpTo = await backupAddonsJson(resolved);
            console.log(`[importer] Created backup at: ${backedUpTo}`);
        }

        const reports: SensitiveUrlFinding[] = [];
        let migratedCount = 0;

        for (const legacy of parsed.addons) {
            const providerId =
                legacy.providerId || `addon:${legacy.slug || 'unknown'}`;
            const mUrl = legacy.manifestUrl || '';
            const bUrl = legacy.baseUrl || '';
            const origUrl = legacy.originalImportUrl;

            // Check for sensitive URLs
            const f1 = detectSensitiveUrl(providerId, 'manifestUrl', mUrl);
            if (f1) reports.push(f1);
            const f2 = detectSensitiveUrl(providerId, 'baseUrl', bUrl);
            if (f2) reports.push(f2);
            if (origUrl) {
                const f3 = detectSensitiveUrl(
                    providerId,
                    'originalImportUrl',
                    origUrl
                );
                if (f3) reports.push(f3);
            }

            const record: AddonRecord = {
                providerId,
                slug: legacy.slug || providerId.replace(/^addon:/, ''),
                name: legacy.name || legacy.manifest?.name || 'Unnamed Addon',
                originalImportUrl: origUrl,
                manifestUrl: mUrl,
                baseUrl: bUrl,
                enabled: legacy.enabled !== false,
                admissionState: legacy.admissionState || 'validated',
                validationFindings: legacy.validationFindings,
                order: typeof legacy.order === 'number' ? legacy.order : 100,
                timeoutMs:
                    typeof legacy.timeoutMs === 'number'
                        ? legacy.timeoutMs
                        : 10000,
                source: legacy.source || 'manual',
                manifest: legacy.manifest || {
                    id: legacy.slug || 'unknown',
                    name: legacy.name || 'Unnamed Addon',
                    version: '1.0.0',
                    resources: [],
                    types: [],
                    catalogs: []
                },
                capabilities: legacy.capabilities,
                version: 1,
                addedAt: legacy.addedAt || new Date().toISOString(),
                updatedAt: legacy.updatedAt || new Date().toISOString(),
                health: legacy.health
            };

            await storage.saveAddon(record);
            migratedCount++;
        }

        if (reports.length > 0) {
            console.warn(
                `\n[importer] WARNING: ${reports.length} sensitive/configured URL fields detected during migration!`
            );
            for (const r of reports) {
                console.warn(
                    `  - [${r.providerId}] ${r.field}: ${r.redactedUrl} (${r.reason})`
                );
            }
            console.warn(
                '  Please review these URLs to ensure secret tokens are sealed or rotated.\n'
            );
        }

        return {
            backedUpTo,
            migrated: migratedCount,
            sensitiveUrlsFound: reports.length,
            sensitiveReports: reports
        };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                migrated: 0,
                sensitiveUrlsFound: 0,
                sensitiveReports: []
            };
        }
        throw err;
    }
}

export async function importSanitizedConfiguration(
    storage: IStorageBackend,
    sanitized: SanitizedExportData
): Promise<{ imported: number }> {
    let count = 0;
    for (const item of sanitized.addons) {
        const existing = await storage.getAddon(item.providerId);
        const record: AddonRecord = {
            providerId: item.providerId,
            slug: item.slug,
            name: item.name,
            originalImportUrl: existing?.originalImportUrl,
            manifestUrl:
                existing?.manifestUrl ||
                `https://${item.slug}.strem.fun/manifest.json`,
            baseUrl: existing?.baseUrl || `https://${item.slug}.strem.fun`,
            enabled: item.enabled,
            admissionState: item.admissionState || 'validated',
            validationFindings: item.validationFindings,
            order: item.order,
            timeoutMs: item.timeoutMs,
            source: (item.source as AddonRecord['source']) || 'manual',
            manifest: item.manifest,
            capabilities: item.capabilities,
            version: (existing?.version || 0) + 1,
            addedAt: item.addedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await storage.saveAddon(record);
        count++;
    }
    return { imported: count };
}
