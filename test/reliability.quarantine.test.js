import test from 'node:test';
import assert from 'node:assert/strict';
import { ReliabilityRegistry } from '../dist/reliability/circuit.js';
import { ProviderSelectionService } from '../dist/providers/selection.js';
import { ProviderBudgetRegistry } from '../dist/capacity/budgets.js';

/**
 * One full open→half-open→re-open cycle. A circuit re-opens only through
 * the half-open cycle, so consecutive failures while already open do NOT
 * count as new opens — quarantine measures recovered-and-failed-again
 * cycles, matching production behavior.
 */
async function reopenCycle(rel, providerId, openTtlMs = 15) {
    await new Promise((r) => setTimeout(r, openTtlMs + 10));
    rel.getState(providerId); // lazily transitions open → half-open
    rel.recordFailure(providerId, 'timeout'); // half-open failure → re-open
}

test('auto-quarantine after repeated circuit opens within the window', async () => {
    const rel = new ReliabilityRegistry(
        { failureThreshold: 1, openTtlMs: 15 },
        { enabled: true, openThreshold: 3, windowMs: 60_000, ttlMs: 3_600_000 }
    );
    // Initial failure opens the circuit (open #1).
    rel.recordFailure('addon:x', 'timeout');
    await reopenCycle(rel, 'addon:x'); // open #2
    assert.equal(rel.isQuarantined('addon:x'), false, 'two opens not enough');
    await reopenCycle(rel, 'addon:x'); // open #3 → quarantine
    assert.equal(rel.isQuarantined('addon:x'), true);

    const q = rel.getQuarantine('addon:x');
    assert.ok(q);
    assert.equal(q.providerId, 'addon:x');
    assert.ok(q.reason.includes('circuit opened 3 times'));
    assert.ok(q.until > Date.now(), 'TTL-based auto-release scheduled');

    assert.equal(rel.listQuarantined().length, 1);
});

test('quarantine disabled by default policy (opt-in via configureQuarantine)', async () => {
    const rel = new ReliabilityRegistry({ failureThreshold: 1, openTtlMs: 10 });
    rel.recordFailure('addon:x', 'timeout');
    for (let i = 0; i < 4; i++) {
        await reopenCycle(rel, 'addon:x', 10);
    }
    assert.equal(rel.isQuarantined('addon:x'), false);
});

test('manual quarantine, release, and zero-TTL manual-only mode', () => {
    const rel = new ReliabilityRegistry(
        {},
        { enabled: true, openThreshold: 100, ttlMs: 0 }
    );
    rel.quarantine('addon:y', 'operator action');
    assert.equal(rel.isQuarantined('addon:y'), true);
    assert.equal(rel.getQuarantine('addon:y').until, null, 'manual-only');
    assert.equal(rel.releaseQuarantine('addon:y'), true);
    assert.equal(rel.isQuarantined('addon:y'), false);
    assert.equal(rel.releaseQuarantine('addon:y'), false);
});

test('quarantine auto-releases after its TTL', async () => {
    const rel = new ReliabilityRegistry(
        { failureThreshold: 1 },
        { enabled: true, openThreshold: 1, windowMs: 60_000, ttlMs: 40 }
    );
    rel.recordFailure('addon:z', 'timeout'); // opens → first open → quarantine
    assert.equal(rel.isQuarantined('addon:z'), true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
        rel.isQuarantined('addon:z'),
        false,
        'expired quarantine releases'
    );
    assert.equal(rel.getQuarantine('addon:z'), null);
});

test('snapshot includes quarantine state', () => {
    const rel = new ReliabilityRegistry(
        { failureThreshold: 1 },
        { enabled: true, openThreshold: 1, windowMs: 60_000, ttlMs: 3_600_000 }
    );
    rel.recordFailure('addon:q', 'timeout');
    const snap = rel.snapshot();
    assert.equal(snap['addon:q'].quarantined, true);
    assert.ok(snap['addon:q'].quarantine);
});

// ── selection integration (quarantine + budgets filter providers) ──────────

function mkAddon(providerId, order) {
    return {
        providerId,
        order,
        name: providerId,
        enabled: true,
        capabilities: {
            stream: [{ mediaTypes: ['movie'], idPrefixes: ['tt'] }],
            subtitles: [],
            catalog: false,
            meta: false,
            status: 'supported'
        },
        manifest: {
            id: providerId.replace('addon:', ''),
            idPrefixes: ['tt'],
            types: ['movie']
        }
    };
}

function mkManager(addons) {
    return {
        getStreamEnabled: () => [...addons].sort((a, b) => a.order - b.order),
        getSubtitleEnabled: () => [],
        getRevision: () => 1
    };
}

const media = {
    type: 'movie',
    tmdbId: '1',
    imdbId: 'tt1',
    title: 'T',
    releaseYear: '2020'
};

test('selection excludes quarantined providers', () => {
    const rel = new ReliabilityRegistry();
    rel.quarantine('addon:bad', 'test');
    const manager = mkManager([
        mkAddon('addon:good', 0),
        mkAddon('addon:bad', 1)
    ]);
    const sel = new ProviderSelectionService(manager, rel);
    const out = sel.selectStreamProviders(media).map((a) => a.providerId);
    assert.deepEqual(out, ['addon:good']);
    // Opt-in override for diagnostics.
    const all = sel
        .selectStreamProviders(media, { includeQuarantined: true })
        .map((a) => a.providerId);
    assert.deepEqual(all, ['addon:good', 'addon:bad']);
});

test('selection excludes budget-exhausted providers', () => {
    const budgets = new ProviderBudgetRegistry({ defaultDailyLimit: 1 });
    budgets.consume('addon:capped'); // exhaust it
    const manager = mkManager([
        mkAddon('addon:fresh', 0),
        mkAddon('addon:capped', 1)
    ]);
    const sel = new ProviderSelectionService(manager, undefined, budgets);
    const out = sel.selectStreamProviders(media).map((a) => a.providerId);
    assert.deepEqual(out, ['addon:fresh']);
});

test('selection combines quarantine and budget filters', () => {
    const rel = new ReliabilityRegistry();
    rel.quarantine('addon:q', 'test');
    const budgets = new ProviderBudgetRegistry({ defaultDailyLimit: 1 });
    budgets.consume('addon:b');
    const manager = mkManager([
        mkAddon('addon:ok', 0),
        mkAddon('addon:q', 1),
        mkAddon('addon:b', 2)
    ]);
    const sel = new ProviderSelectionService(manager, rel, budgets);
    const out = sel.selectStreamProviders(media).map((a) => a.providerId);
    assert.deepEqual(out, ['addon:ok']);
});
