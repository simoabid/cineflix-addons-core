/**
 * Marketplace / import-policy tests (Phase 12 §15.4).
 *
 * Covers manifest fingerprinting (canonical, order-independent), trust
 * classification precedence, import-policy evaluation (denylist enforcement
 * + trust-gated auto-enable), config mapping, and the manager-level trust
 * gate (below-minimum installs stay disabled + pending) plus fingerprint
 * drift detection on refresh.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
    manifestFingerprint,
    classifyManifest,
    evaluateImportPolicy,
    marketplacePolicyFromConfig
} from '../dist/addons/marketplace.js';
import { AddonManager } from '../dist/addons/manager.js';
import { devConfig, startFakeAddonServer } from './helpers/harness.js';

const MANIFEST = {
    id: 'org.market.test',
    version: '1.0.0',
    name: 'Market Test',
    resources: ['stream'],
    types: ['movie']
};

const policy = (overrides = {}) => ({
    trustedIds: [],
    trustedFingerprints: [],
    blockedIds: [],
    blockedFingerprints: [],
    minTrustForEnable: 'unknown',
    enforceDenylist: true,
    ...overrides
});

// ── Fingerprinting ───────────────────────────────────────────────────────────

describe('manifestFingerprint', () => {
    test('is order-independent over keys', () => {
        const a = manifestFingerprint({ ...MANIFEST });
        const b = manifestFingerprint({
            types: ['movie'],
            resources: ['stream'],
            name: 'Market Test',
            version: '1.0.0',
            id: 'org.market.test'
        });
        assert.equal(a, b);
    });

    test('changes when content changes', () => {
        const a = manifestFingerprint({ ...MANIFEST });
        const b = manifestFingerprint({
            ...MANIFEST,
            version: '1.0.1'
        });
        assert.notEqual(a, b);
    });

    test('is a hex sha-256 and stable across calls', () => {
        const fp = manifestFingerprint(MANIFEST);
        assert.match(fp, /^[0-9a-f]{64}$/);
        assert.equal(fp, manifestFingerprint(MANIFEST));
    });
});

// ── Classification precedence ────────────────────────────────────────────────

describe('classifyManifest', () => {
    test('denylist fingerprint wins over everything', () => {
        const fp = manifestFingerprint(MANIFEST);
        const c = classifyManifest(
            MANIFEST,
            policy({
                blockedFingerprints: [fp],
                trustedIds: ['org.market.test']
            })
        );
        assert.equal(c.level, 'blocked');
        assert.equal(c.matchedBy, 'fingerprint');
    });

    test('denylist id (case-insensitive) beats trusted lists', () => {
        const c = classifyManifest(
            MANIFEST,
            policy({
                blockedIds: ['ORG.MARKET.TEST'],
                trustedIds: ['org.market.test']
            })
        );
        assert.equal(c.level, 'blocked');
        assert.equal(c.matchedBy, 'id');
    });

    test('trusted fingerprint classifies as trusted', () => {
        const fp = manifestFingerprint(MANIFEST);
        const c = classifyManifest(
            MANIFEST,
            policy({ trustedFingerprints: [fp] })
        );
        assert.equal(c.level, 'trusted');
        assert.equal(c.matchedBy, 'fingerprint');
    });

    test('trusted id (case-insensitive) classifies as known', () => {
        const c = classifyManifest(
            MANIFEST,
            policy({ trustedIds: ['Org.Market.Test'] })
        );
        assert.equal(c.level, 'known');
        assert.equal(c.matchedBy, 'id');
    });

    test('unlisted manifests are unknown', () => {
        const c = classifyManifest(MANIFEST, policy());
        assert.equal(c.level, 'unknown');
        assert.equal(c.matchedBy, undefined);
    });
});

// ── Import policy evaluation ─────────────────────────────────────────────────

describe('evaluateImportPolicy', () => {
    test('blocked + enforced denylist rejects with a finding', () => {
        const fp = manifestFingerprint(MANIFEST);
        const d = evaluateImportPolicy(
            MANIFEST,
            policy({ blockedFingerprints: [fp] })
        );
        assert.equal(d.allowed, false);
        assert.equal(d.mayAutoEnable, false);
        assert.equal(d.finding?.severity, 'error');
        assert.equal(d.finding?.code, 'policy_violation');
    });

    test('blocked without enforcement stays allowed but never auto-enables', () => {
        const fp = manifestFingerprint(MANIFEST);
        const d = evaluateImportPolicy(
            MANIFEST,
            policy({ blockedFingerprints: [fp], enforceDenylist: false })
        );
        assert.equal(d.allowed, true);
        assert.equal(d.trustLevel, 'blocked');
        assert.equal(d.mayAutoEnable, false);
    });

    test('default min trust (unknown) auto-enables unknown manifests', () => {
        const d = evaluateImportPolicy(MANIFEST, policy());
        assert.equal(d.allowed, true);
        assert.equal(d.trustLevel, 'unknown');
        assert.equal(d.mayAutoEnable, true);
    });

    test('raising min trust to known holds unknown installs for review', () => {
        const d = evaluateImportPolicy(
            MANIFEST,
            policy({ minTrustForEnable: 'known' })
        );
        assert.equal(d.allowed, true);
        assert.equal(d.mayAutoEnable, false);
    });

    test('known-level manifests pass a known minimum', () => {
        const d = evaluateImportPolicy(
            MANIFEST,
            policy({
                trustedIds: ['org.market.test'],
                minTrustForEnable: 'known'
            })
        );
        assert.equal(d.trustLevel, 'known');
        assert.equal(d.mayAutoEnable, true);
    });
});

// ── Config mapping ───────────────────────────────────────────────────────────

describe('marketplacePolicyFromConfig', () => {
    test('maps the §15.4 config fields', () => {
        const cfg = {
            marketplaceTrustedIds: ['a', 'b'],
            marketplaceTrustedFingerprints: ['fp1'],
            marketplaceBlockedIds: ['bad'],
            marketplaceBlockedFingerprints: ['fp2'],
            marketplaceMinTrustForEnable: 'trusted',
            marketplaceEnforceDenylist: false
        };
        const p = marketplacePolicyFromConfig(cfg);
        assert.deepEqual(p, {
            trustedIds: ['a', 'b'],
            trustedFingerprints: ['fp1'],
            blockedIds: ['bad'],
            blockedFingerprints: ['fp2'],
            minTrustForEnable: 'trusted',
            enforceDenylist: false
        });
    });
});

// ── Manager trust gate + drift detection (live fake upstream) ────────────────

describe('AddonManager marketplace integration', () => {
    let addon;
    const fakeRegistry = {
        hasProvider: () => false,
        register: () => {},
        unregister: () => {},
        listProviders: () => [],
        getProviders: () => []
    };

    before(async () => {
        addon = await startFakeAddonServer({ manifest: MANIFEST });
    });

    after(async () => {
        await addon.close();
    });

    function makeManager(cfgOverrides) {
        const cfg = devConfig(cfgOverrides);
        return AddonManager.create(fakeRegistry, cfg);
    }

    test('below-minimum trust installs stay disabled + pending', async () => {
        const manager = makeManager({
            marketplaceMinTrustForEnable: 'known'
        });
        const res = await manager.install(addon.manifestUrl, 'url');
        assert.equal(res.ok, true);
        assert.equal(res.marketplace?.level, 'unknown');
        assert.equal(res.marketplace?.matchedBy, undefined);
        assert.equal(res.addon?.enabled, false);
        assert.equal(res.addon?.admissionState, 'pending');
        assert.match(res.addon?.manifestFingerprint ?? '', /^[0-9a-f]{64}$/);
    });

    test('default policy auto-enables unknown manifests', async () => {
        const manager = makeManager({});
        const res = await manager.install(addon.manifestUrl, 'url');
        assert.equal(res.ok, true);
        assert.equal(res.addon?.enabled, true);
        assert.equal(res.addon?.admissionState, 'validated');
    });

    test('denylisted fingerprints are rejected outright', async () => {
        const fp = manifestFingerprint(MANIFEST);
        const manager = makeManager({
            marketplaceBlockedFingerprints: [fp]
        });
        const res = await manager.install(addon.manifestUrl, 'url');
        assert.equal(res.ok, false);
        assert.match(res.error ?? '', /denylist/i);
        assert.equal(
            res.findings?.some((f) => f.code === 'policy_violation'),
            true
        );
    });

    test('refresh surfaces fingerprint drift when the manifest changes', async () => {
        // Install from a server whose manifest we mutate after install.
        let version = '1.0.0';
        const mutable = await startFakeAddonServer({
            manifest: () => ({ ...MANIFEST, version: String(version) })
        });
        try {
            const manager = makeManager({});
            const first = await manager.install(mutable.manifestUrl, 'url');
            assert.equal(first.ok, true);
            const originalFp = first.addon?.manifestFingerprint;

            version = '2.0.0'; // upstream manifest changes under us
            const refreshed = await manager.refresh(
                first.addon?.providerId ?? ''
            );
            assert.equal(refreshed.ok, true);
            assert.notEqual(refreshed.marketplace?.fingerprint, originalFp);
            assert.equal(
                refreshed.findings?.some((f) => f.code === 'fingerprint_drift'),
                true
            );
        } finally {
            await mutable.close();
        }
    });
});
