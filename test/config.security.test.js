import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertProductionSafe,
    resolvePublicUrl
} from '../dist/config.js';

function prodBase(overrides = {}) {
    return {
        name: 'AddonsCore',
        version: '1.0.0',
        host: '0.0.0.0',
        port: 3006,
        publicUrl: 'https://addons.example',
        corsOrigin: 'https://cineflix.example',
        nodeEnv: 'production',
        internalDebug: false,
        tmdbApiKey: 'x',
        tmdbCacheTTL: 1,
        cacheType: 'redis',
        redis: { host: 'localhost', port: 6379 },
        store: 'file',
        dataFile: './data/addons.json',
        seedUrls: [],
        adminEnabled: true,
        adminToken: 'prod-admin-token-value',
        authMode: 'static-token',
        allowInsecureAdmin: false,
        adminTokenRole: 'admin',
        authSessionSecret: 'sess',
        serviceJwtSecret: undefined,
        proxyUserHeader: 'x-forwarded-user',
        proxyRoleHeader: 'x-forwarded-role',
        sessionTtlSec: 3600,
        enableNativeAddon: false,
        debridProvider: 'none',
        debridApiKey: '',
        healthIntervalMinutes: 15,
        autoRefresh: false,
        secretsMasterKey: Buffer.alloc(32).toString('base64'),
        requireSecretsMasterKey: true,
        allowHttpUpstreams: false,
        outboundHostAllowlist: [],
        outboundHostAllowSuffixes: [],
        importMaxUrls: 50,
        importMaxConcurrent: 4,
        importMaxBytes: 1_000_000,
        importTimeoutMs: 20_000,
        importEnableOnInstall: false,
        secureProxy: true,
        allowLegacyProxy: false,
        playbackGrantSecret: 'this-is-a-very-strong-grant-secret-32+chars-1234567890',
        playbackGrantTtlSec: 7200,
        proxyTimeoutMs: 30_000,
        proxyMaxManifestBytes: 1_000_000,
        proxyMaxBufferBytes: 2_000_000,
        proxyMaxStreamBytes: 536_870_912,
        maxBodyBytes: 1_000_000,
        maxQueryLength: 4096,
        maxHeaderBytes: 16_384,
        maxJsonDepth: 32,
        globalRequestTimeoutMs: 120_000,
        auditLogFile: './data/audit.jsonl',
        auditEnabled: true,
        importMaxBatchBytes: 5_242_880,
        importJobTimeoutMs: 60_000,
        csrfEnabled: true,
        trustedProxyCidrs: [],
        ...overrides
    };
}

test('production accepts a fully hardened config', () => {
    assert.doesNotThrow(() => assertProductionSafe(prodBase()));
});

test('production refuses AUTH_MODE=disabled', () => {
    assert.throws(
        () => assertProductionSafe(prodBase({ authMode: 'disabled' })),
        /AUTH_MODE=disabled/
    );
});

test('production refuses static-token without ADMIN_TOKEN', () => {
    assert.throws(
        () =>
            assertProductionSafe(
                prodBase({ authMode: 'static-token', adminToken: undefined })
            ),
        /ADMIN_TOKEN/
    );
});

test('production refuses missing PUBLIC_URL', () => {
    assert.throws(
        () => assertProductionSafe(prodBase({ publicUrl: undefined })),
        /PUBLIC_URL/
    );
});

test('production refuses http PUBLIC_URL', () => {
    assert.throws(
        () =>
            assertProductionSafe(
                prodBase({ publicUrl: 'http://addons.example' })
            ),
        /https/
    );
});

test('production refuses wildcard CORS', () => {
    assert.throws(
        () => assertProductionSafe(prodBase({ corsOrigin: '*' })),
        /CORS_ORIGIN/
    );
});

test('production refuses legacy proxy and insecure proxy', () => {
    assert.throws(
        () => assertProductionSafe(prodBase({ allowLegacyProxy: true })),
        /ALLOW_LEGACY_PROXY|legacy/i
    );
    assert.throws(
        () => assertProductionSafe(prodBase({ secureProxy: false })),
        /SECURE_PROXY/
    );
});

test('production refuses missing secrets master key when required', () => {
    assert.throws(
        () =>
            assertProductionSafe(
                prodBase({
                    secretsMasterKey: undefined,
                    requireSecretsMasterKey: true
                })
            ),
        /SECRETS_MASTER_KEY/
    );
});

test('production refuses ALLOW_HTTP_UPSTREAMS', () => {
    assert.throws(
        () => assertProductionSafe(prodBase({ allowHttpUpstreams: true })),
        /ALLOW_HTTP_UPSTREAMS/
    );
});

test('non-prod disabled auth on non-loopback requires acknowledgement', () => {
    assert.throws(
        () =>
            assertProductionSafe(
                prodBase({
                    nodeEnv: 'development',
                    authMode: 'disabled',
                    allowInsecureAdmin: false,
                    host: '0.0.0.0',
                    // relax other prod-only checks
                    publicUrl: undefined,
                    corsOrigin: '*',
                    requireSecretsMasterKey: false,
                    secretsMasterKey: undefined,
                    allowHttpUpstreams: true,
                    secureProxy: true,
                    allowLegacyProxy: false,
                    adminToken: undefined
                })
            ),
        /ALLOW_INSECURE_ADMIN/
    );
});

test('resolvePublicUrl strips trailing slash', () => {
    assert.equal(
        resolvePublicUrl(
            prodBase({ publicUrl: 'https://addons.example/' })
        ),
        'https://addons.example'
    );
});
