/**
 * Coverage gate (Phase 9 §12.2).
 *
 * Runs the test suite with V8 coverage via the node:test lcov reporter
 * (the default TAP coverage printer crashes on this tree in Node 22.x),
 * aggregates line/branch/function coverage from the lcov output, and fails
 * when any metric is under threshold.
 *
 * Thresholds start slightly below the Phase 9 baseline (79.5/76.5/84.9) and
 * must be raised over time — they exist to prevent regression, not to reward
 * low-value tests. Override temporarily via COVERAGE_* env vars.
 *
 * Usage: npm run check:coverage   (expects dist/ to be fresh; `npm run build` first)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not URL.pathname) — the checkout path can contain spaces.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Thresholds (raise gradually; see file header) ────────────────────────────
const THRESHOLDS = {
    lines: Number(process.env.COVERAGE_LINES ?? 75),
    branches: Number(process.env.COVERAGE_BRANCHES ?? 70),
    functions: Number(process.env.COVERAGE_FUNCTIONS ?? 80)
};

function parseLcov(text) {
    let lf = 0,
        lh = 0,
        brf = 0,
        brh = 0,
        fnf = 0,
        fnh = 0;
    for (const line of text.split('\n')) {
        if (line.startsWith('LF:')) lf += Number(line.slice(3));
        else if (line.startsWith('LH:')) lh += Number(line.slice(3));
        else if (line.startsWith('BRF:')) brf += Number(line.slice(4));
        else if (line.startsWith('BRH:')) brh += Number(line.slice(4));
        else if (line.startsWith('FNF:')) fnf += Number(line.slice(4));
        else if (line.startsWith('FNH:')) fnh += Number(line.slice(4));
    }
    return {
        lines: lf === 0 ? 100 : (lh * 100) / lf,
        branches: brf === 0 ? 100 : (brh * 100) / brf,
        functions: fnf === 0 ? 100 : (fnh * 100) / fnf
    };
}

function nodeCandidates() {
    const candidates = [process.execPath];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        candidates.push(path.join(dir, 'node'));
    }
    candidates.push('node');
    return [...new Set(candidates)];
}

function runTests(lcovPath) {
    const args = [
        '--test',
        '--experimental-test-coverage',
        '--test-reporter=lcov',
        `--test-reporter-destination=${lcovPath}`,
        '--test-reporter=dot',
        '--test-reporter-destination=stdout',
        ...process.argv.slice(2).filter((a) => a !== '--'),
        'test/*.test.js'
    ];

    const attempt = (binaries) =>
        new Promise((resolve, reject) => {
            if (binaries.length === 0) {
                reject(new Error('no working Node executable found'));
                return;
            }
            const [bin, ...rest] = binaries;
            const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit' });
            // Broken version-manager shims exist on disk but cannot exec;
            // fall through to the next candidate on spawn errors only.
            child.on('error', (err) => {
                console.error(`[cov-gate] spawn ${bin} failed: ${err.message}`);
                attempt(rest).then(resolve, reject);
            });
            child.on('exit', (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error(`tests failed (${code})`))
            );
        });

    return attempt(nodeCandidates());
}

async function main() {
    const dir = mkdtempSync(path.join(tmpdir(), 'addons-core-cov-'));
    const lcovPath = path.join(dir, 'lcov.info');
    try {
        await runTests(lcovPath);
        const totals = parseLcov(readFileSync(lcovPath, 'utf8'));
        if (process.env.COV_DEBUG)
            console.error(`[cov-gate] lcov bytes=${statSync(lcovPath).size}`);
        let failed = false;
        console.log('\n┌─ Coverage gate ──────────────────────────────');
        for (const [name, key] of [
            ['lines', 'lines'],
            ['branches', 'branches'],
            ['functions', 'functions']
        ]) {
            const pct = totals[key];
            const min = THRESHOLDS[key];
            const ok = pct >= min;
            if (!ok) failed = true;
            console.log(
                `│ ${name.padEnd(10)} ${pct.toFixed(1).padStart(5)}%  ` +
                    `(threshold ${min}%)  ${ok ? 'PASS' : 'FAIL'}`
            );
        }
        console.log('└──────────────────────────────────────────────');
        if (failed) {
            console.error(
                '\nCoverage below threshold. Add meaningful tests — do not weaken the gate.'
            );
            process.exitCode = 1;
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
});
