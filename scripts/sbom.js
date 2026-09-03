/**
 * SBOM generator (Phase 10 §13.1/§13.5).
 *
 * Produces a CycloneDX 1.5 JSON Software Bill of Materials from the committed
 * package-lock.json — no third-party dependency required. The SBOM covers the
 * application component plus every locked package (runtime and dev) with
 * purl identifiers so registry admission and release audits can diff them.
 *
 * Usage: npm run sbom   → writes sbom/addons-core.cdx.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(
    readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')
);
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const serialNumber = `urn:uuid:${createHash('sha256')
    .update(JSON.stringify(lock.packages ?? {}))
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5')}`;

const components = [];
for (const [loc, info] of Object.entries(lock.packages ?? {})) {
    if (loc === '' || !info.version) continue;
    const name = loc
        .replace(/^node_modules\//, '')
        .replace(/.*\/node_modules\//, '');
    components.push({
        type: 'library',
        'bom-ref': `pkg:npm/${name}@${info.version}`,
        name,
        version: info.version,
        purl: `pkg:npm/${name}@${info.version}`,
        scope: info.dev ? 'excluded' : 'required'
    });
}
components.sort((a, b) => a.name.localeCompare(b.name));

const appRef = `pkg:npm/${pkg.name}@${pkg.version}`;
const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber,
    version: 1,
    metadata: {
        timestamp: new Date().toISOString(),
        component: {
            type: 'application',
            'bom-ref': appRef,
            name: pkg.name,
            version: pkg.version,
            description: pkg.description
        },
        tools: [
            { vendor: 'addons-core', name: 'scripts/sbom.js', version: '1.0' }
        ]
    },
    components
};

const outDir = path.join(ROOT, 'sbom');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'addons-core.cdx.json');
writeFileSync(outFile, `${JSON.stringify(bom, null, 2)}\n`);
console.log(
    `SBOM written: sbom/addons-core.cdx.json (${components.length} components)`
);
