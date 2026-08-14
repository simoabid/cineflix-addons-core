import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RUNBOOKS_DIR = path.resolve('docs/runbooks');

const EXPECTED_RUNBOOKS = [
    'provider-failing.md',
    'residential-proxy-failure.md',
    'debrid-outage.md',
    'tmdb-outage.md',
    'storage-cache-outage.md',
    'stuck-jobs.md',
    'high-proxy-egress.md',
    'credential-rotation.md',
    'data-restore.md',
    'ssrf-security-incident.md',
    'emergency-quarantine-addon.md',
    'deployment-rollback.md'
];

test('runbooks: INDEX.md and README.md exist in docs/runbooks', () => {
    const indexPath = path.join(RUNBOOKS_DIR, 'INDEX.md');
    const readmePath = path.join(RUNBOOKS_DIR, 'README.md');

    assert.ok(fs.existsSync(indexPath), 'INDEX.md must exist');
    assert.ok(fs.existsSync(readmePath), 'README.md must exist');

    const indexContent = fs.readFileSync(indexPath, 'utf8');
    for (const rb of EXPECTED_RUNBOOKS) {
        assert.ok(
            indexContent.includes(rb),
            `INDEX.md must link to runbook: ${rb}`
        );
    }
});

test('runbooks: all 12 operational runbooks exist and have required sections', () => {
    for (const rb of EXPECTED_RUNBOOKS) {
        const rbPath = path.join(RUNBOOKS_DIR, rb);
        assert.ok(fs.existsSync(rbPath), `Runbook ${rb} must exist`);

        const content = fs.readFileSync(rbPath, 'utf8');
        assert.ok(content.includes('Metadata') || content.includes('Overview'), `${rb} missing Metadata section`);
        assert.ok(
            content.includes('Triage') ||
            content.includes('Diagnosis') ||
            content.includes('Procedure') ||
            content.includes('Mitigation') ||
            content.includes('Step-by-Step'),
            `${rb} missing diagnostic/mitigation section`
        );
        assert.ok(
            content.includes('Verification') ||
            content.includes('Validation'),
            `${rb} missing Verification section`
        );
    }
});
