import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debridService } from '../dist/debrid/service.js';
import { createAuditLogger } from '../dist/security/audit.js';

test('DebridService configuration, status, and resolution caching', async () => {
    // 1. Initial unconfigured state
    debridService.configure({ provider: 'none', apiKey: '' });
    assert.equal(debridService.isEnabled(), false);

    const statusOff = debridService.status();
    assert.equal(statusOff.enabled, false);
    assert.equal(statusOff.hasKey, false);

    const resDisabled = await debridService.resolveCached({
        infoHash: '0123456789abcdef0123456789abcdef01234567'
    });
    assert.equal(resDisabled.kind, 'provider-error');
    assert.equal(resDisabled.code, 'DEBRID_DISABLED');

    // 2. Configure with RealDebrid
    debridService.configure({
        provider: 'realdebrid',
        apiKey: 'test-api-key-rd'
    });
    assert.equal(debridService.isEnabled(), true);
    const statusOn = debridService.status();
    assert.equal(statusOn.enabled, true);
    assert.equal(statusOn.hasKey, true);
    assert.equal(statusOn.provider, 'realdebrid');
    assert.ok(statusOn.capabilities?.supportsFileSelection);

    // 3. Clear cache when reconfiguring
    debridService.clearCache();
    assert.equal(debridService.status().cachedLinksCount, 0);

    // Reset back to none
    debridService.configure({ provider: 'none', apiKey: '' });
});

test('DebridService raises operator alert on repeated authentication failures', async () => {
    const audit = createAuditLogger({ enabled: true });
    debridService.setAuditLogger(audit);

    // Mock resolver with auth failures
    const failingResolver = {
        id: 'realdebrid',
        name: 'Real-Debrid',
        getCapabilities: () => ({
            supportsInstantAvailabilityCheck: true,
            supportsFileSelection: true,
            supportsUncachedTransfers: true,
            supportsLinkExpiry: false
        }),
        checkCredentials: async () => ({
            ok: false,
            error: 'HTTP 401: bad_token',
            errorKind: 'auth_failure'
        }),
        check: async () => ({ ok: false, error: 'HTTP 401: bad_token' }),
        resolveCached: async () => ({
            kind: 'provider-error',
            code: 'AUTH_FAILED',
            errorKind: 'auth_failure',
            retryable: false,
            safeMessage: 'Authentication failed'
        }),
        resolve: async () => null,
        cleanup: async () => {},
        classifyError: () => 'auth_failure'
    };

    debridService.configure({ provider: 'realdebrid', apiKey: 'bad-key' });
    debridService['resolver'] = failingResolver;

    // Trigger 2 failures (below threshold of 3)
    await debridService.checkCredentials();
    await debridService.checkCredentials();
    assert.equal(debridService.status().activeAlerts.length, 0);

    // 3rd failure reaches threshold -> alert raised!
    await debridService.checkCredentials();
    const status = debridService.status();
    assert.equal(status.activeAlerts.length, 1);
    assert.equal(status.activeAlerts[0].code, 'DEBRID_AUTH_FAILURE');
    assert.ok(status.activeAlerts[0].failuresInWindow >= 3);

    // Check that audit recorded alert
    const recentAudit = audit.recent(10);
    const alertEvent = recentAudit.find(e => e.action === 'alert.debrid_auth_failure');
    assert.ok(alertEvent);
    assert.equal(alertEvent.outcome, 'failure');

    // Reset
    debridService.configure({ provider: 'none', apiKey: '' });
});
