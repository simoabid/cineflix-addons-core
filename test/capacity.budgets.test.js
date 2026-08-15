import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ProviderBudgetRegistry,
    EgressBudgetMonitor
} from '../dist/capacity/budgets.js';

test('provider budget unlimited when default limit is 0', () => {
    const b = new ProviderBudgetRegistry({ defaultDailyLimit: 0 });
    for (let i = 0; i < 100; i++) {
        assert.equal(b.consume('addon:x').allowed, true);
    }
    assert.equal(b.isExhausted('addon:x'), false);
});

test('provider budget exhausts at the daily limit and reports reset', () => {
    const b = new ProviderBudgetRegistry({ defaultDailyLimit: 3 });
    assert.equal(b.consume('addon:x').allowed, true); // 1
    assert.equal(b.consume('addon:x').allowed, true); // 2
    const last = b.consume('addon:x'); // 3
    assert.equal(last.allowed, true);
    assert.equal(last.used, 3);
    assert.ok(last.resetAt > Date.now(), 'resetAt is a future epoch');

    const rejected = b.consume('addon:x'); // 4 → over
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.used, 3, 'over-budget call does not count as usable');
    assert.equal(b.isExhausted('addon:x'), true);

    const snap = b.snapshot();
    // Snapshot counts only allowed calls; rejected attempts don't inflate `used`
    // so `used` stays at the limit (3/3) once exhausted, while `exhausted`
    // flips via `isExhausted` (>= limit) and prevents the slip where one more
    // concurrent caller could sneak past selection before consume is checked.
    assert.equal(snap['addon:x'].used, 3);
    assert.equal(snap['addon:x'].exhausted, true);
});

test('per-provider overrides take precedence', () => {
    const b = new ProviderBudgetRegistry({
        defaultDailyLimit: 10,
        overrides: { 'addon:fragile': 1 }
    });
    assert.equal(b.consume('addon:fragile').allowed, true);
    assert.equal(b.consume('addon:fragile').allowed, false);
    // Default still applies to others.
    assert.equal(b.consume('addon:normal').allowed, true);
    assert.equal(b.consume('addon:normal').allowed, true);
});

test('budget reset clears counters', () => {
    const b = new ProviderBudgetRegistry({ defaultDailyLimit: 1 });
    b.consume('addon:x');
    assert.equal(b.isExhausted('addon:x'), true);
    b.reset('addon:x');
    assert.equal(b.isExhausted('addon:x'), false);
});

test('configure() updates limits without resetting running counters', () => {
    const b = new ProviderBudgetRegistry({ defaultDailyLimit: 5 });
    b.consume('addon:x');
    b.consume('addon:x');
    b.configure({ defaultDailyLimit: 10 });
    const snap = b.snapshot();
    assert.equal(snap['addon:x'].limit, 10);
    assert.equal(snap['addon:x'].used, 2);
    assert.equal(b.isExhausted('addon:x'), false);
    // Tightening below current usage marks it exhausted.
    b.configure({ defaultDailyLimit: 1 });
    assert.equal(b.isExhausted('addon:x'), true);
});

test('egress monitor reports ok below the warn threshold', () => {
    const m = new EgressBudgetMonitor({ dailyBudgetBytes: 1000 });
    m.record(700);
    const s = m.state();
    assert.equal(s.level, 'ok');
    assert.equal(s.usedPct, 70);
});

test('egress monitor warns at 75% and reports exceeded at 100%', () => {
    const m = new EgressBudgetMonitor({ dailyBudgetBytes: 1000, warnAt: 0.75 });
    m.record(750);
    assert.equal(m.state().level, 'warning');
    m.record(300);
    const s = m.state();
    assert.equal(s.level, 'exceeded');
    assert.equal(s.dailyBytes, 1050);
    assert.ok(s.resetsAt);
});

test('egress monitor tracks proxy bytes separately', () => {
    const m = new EgressBudgetMonitor({
        dailyBudgetBytes: 10_000,
        proxyBudgetBytes: 1000
    });
    m.record(900, true);
    m.record(5000, false);
    const s = m.state();
    assert.equal(s.proxyBytes, 900);
    assert.equal(s.dailyBytes, 5900);
    assert.equal(s.level, 'ok');
    assert.equal(s.proxyUsedPct, 90);
    m.record(200, true);
    assert.equal(m.state().proxyUsedPct, 110);
});

test('disabled budgets (0) never alert', () => {
    const m = new EgressBudgetMonitor({
        dailyBudgetBytes: 0,
        proxyBudgetBytes: 0
    });
    m.record(Number.MAX_SAFE_INTEGER / 2);
    const s = m.state();
    assert.equal(s.level, 'ok');
    assert.equal(s.usedPct, 0);
    assert.equal(s.proxyUsedPct, 0);
});
