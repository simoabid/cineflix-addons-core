/**
 * End-to-end lifecycle tests (Phase 9 §12.1).
 *
 * Boots the real compiled server (dist/server.js) as a child process — the
 * process-level equivalent of the container image — against fake upstreams:
 *
 *   fake TMDB API   (TMDB_API_BASE_URL override)
 *   fake addon      (Stremio manifest + stream/subtitle endpoints)
 *   fake media      (range-capable byte origin behind playback grants)
 *
 * Exercises, in order:
 *   1. Admin authentication (anonymous denial, login, session, CSRF)
 *   2. Import → validation → enable → query → playback grant → proxy path
 *      (including an SSRF import denial)
 *   3. Health job → state update → management API
 *   4. Debrid configuration and key redaction
 *   5. Graceful shutdown and restart with persisted state
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { scratchFile, startFakeAddonServer } from '../helpers/harness.js';
import { startServer, createClient } from './helpers/server.js';
import { startFakeTmdb, startFakeMedia } from './helpers/fakes.js';

const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef';
const SESSION_COOKIE = 'addons_core_session';
const DATA_FILE = scratchFile('e2e-lifecycle');
// safeSlug lowercases and hyphenates the manifest id, so `org.fake.addon`
// becomes `org-fake-addon` → provider id `addon:org-fake-addon`.
const PROVIDER_ID = 'addon:org-fake-addon';

let tmdb;
let media;
let state; // mutable fake-addon behavior
let addon;
let server;
let client;

/**
 * Boot a child server with the fake addon seeded via ADDONS_SEED_URLS.
 *
 * The management-API import validator deliberately rejects loopback hosts in
 * every environment (defense-in-depth at the API boundary — see
 * importUrlBodyValidator), so hermetic e2e installs go through the same seed
 * path operators use for boot-time addons, which validates via the manager's
 * cfg-aware URL policy (ALLOW_HTTP_UPSTREAMS + loopback suffix exemption).
 */
async function bootSeededServer(dataFile) {
    return startServer({
        dataFile,
        env: {
            adminToken: ADMIN_TOKEN,
            tmdbBaseUrl: `${tmdb.baseUrl}/3`,
            extra: { ADDONS_SEED_URLS: addon.manifestUrl }
        }
    });
}

before(async () => {
    tmdb = await startFakeTmdb();
    media = await startFakeMedia();
    // Mutable manifest status so the health-job test can flip upstream health.
    state = { manifestStatus: 200 };
    addon = await startFakeAddonServer({
        get manifestStatus() {
            return state.manifestStatus;
        },
        streamsFor: () => [
            { url: `${media.baseUrl}/video.mp4`, title: 'E2E Stream 1080p' }
        ]
    });

    await fs.rm(DATA_FILE, { force: true });
    server = await bootSeededServer(DATA_FILE);
    client = createClient(server.baseUrl);
});

after(async () => {
    if (server) await server.stop({ timeoutMs: 8000 }).catch(() => {});
    await Promise.all([
        addon?.close(),
        media?.close(),
        tmdb?.close(),
        fs.rm(DATA_FILE, { force: true })
    ]);
});

// ── 1. Admin authentication ───────────────────────────────────────────────────

test('management API denies anonymous callers', async () => {
    const anon = createClient(server.baseUrl);
    const listed = await anon.get('/v1/addons');
    assert.equal(listed.status, 401);
    assert.equal(listed.body.error.code, 'UNAUTHORIZED');

    const imported = await anon.post('/v1/addons/import/url', {
        url: addon.manifestUrl
    });
    assert.equal(imported.status, 401);
});

test('login rejects a wrong token and accepts the right one', async () => {
    const bad = await client.login('definitely-not-the-token');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'UNAUTHORIZED');

    const ok = await client.login(ADMIN_TOKEN);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.actor.role, 'admin');
    assert.ok(ok.body.csrfToken, 'login mints a CSRF token');
    const setCookies = ok.headers.getSetCookie().join('\n');
    assert.ok(
        setCookies.includes(`${SESSION_COOKIE}=`),
        'session cookie is set'
    );
});

test('authenticated identity endpoint reflects the session', async () => {
    const me = await client.get('/v1/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.actor.id, 'admin-token');
    assert.equal(me.body.authMode, 'static-token');
});

test('cookie-authenticated mutations require the CSRF header', async () => {
    const sid = client.jar.get(SESSION_COOKIE);
    assert.ok(sid, 'session cookie present after login');
    const res = await fetch(`${server.baseUrl}/v1/addons/reorder`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            cookie: `${SESSION_COOKIE}=${sid}`
        },
        body: JSON.stringify({ order: [] })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'CSRF_FAILED');
});

// ── 2. Import → validation → enable → query → grant → proxy ─────────────────

test('seeded addon is validated and enabled at boot', async () => {
    const list = await client.get('/v1/addons');
    assert.equal(list.status, 200);
    const entry = list.body.addons.find((a) => a.id === PROVIDER_ID);
    assert.ok(
        entry,
        `seeded addon present: ${list.body.addons.map((a) => a.id)}`
    );
    assert.equal(entry.enabled, true);
    assert.equal(entry.admissionState, 'validated');
});

test('API import validation rejects loopback and metadata URLs', async () => {
    // The route validator blocks literal loopback hosts unconditionally —
    // defense-in-depth that holds even when runtime dev exemptions exist.
    const loopback = await client.post('/v1/addons/import/url', {
        url: addon.manifestUrl
    });
    assert.equal(loopback.status, 400);
    assert.equal(loopback.body.error.code, 'VALIDATION_ERROR');

    const metadata = await client.post('/v1/addons/import/url', {
        url: 'http://169.254.169.254/latest/meta-data/manifest.json'
    });
    if (metadata.status === 200) {
        assert.equal(metadata.body.ok, false, 'metadata URL must not install');
    } else {
        assert.ok(
            [400, 403, 422].includes(metadata.status),
            `got ${metadata.status}`
        );
    }
});

test('imported provider appears in /v1/providers with revision header', async () => {
    const res = await client.get('/v1/providers');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(
        res.body.some((p) => p.id === PROVIDER_ID),
        `expected ${PROVIDER_ID} in ${res.body.map((p) => p.id)}`
    );
    assert.ok(res.headers.get('x-provider-revision'));
});

test('progressive query returns a proxied playback grant URL', async () => {
    const res = await client.get(
        '/v1/movies/27205/providers/' + encodeURIComponent(PROVIDER_ID)
    );
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
    assert.ok(Array.isArray(res.body.sources));
    assert.ok(res.body.sources.length >= 1, 'fake addon returned one stream');
    const url = res.body.sources[0].url;
    assert.match(url, /\/v1\/proxy\/grant\//, 'source uses a playback grant');
    globalThis.__e2eGrantUrl = new URL(url, server.baseUrl).toString();
});

test('playback grant proxies upstream bytes', async () => {
    const res = await fetch(globalThis.__e2eGrantUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body.subarray(0, 64), media.payload.subarray(0, 64));
    assert.equal(body.length, media.payload.length);
});

test('range requests through the grant return partial content', async () => {
    const res = await fetch(globalThis.__e2eGrantUrl, {
        headers: { range: 'bytes=100-115' }
    });
    assert.equal(res.status, 206);
    assert.equal(
        res.headers.get('content-range'),
        `bytes 100-115/${media.payload.length}`
    );
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.length, 16);
    assert.deepEqual(body, media.payload.subarray(100, 116));
});

test('unknown grants are rejected without upstream contact', async () => {
    const res = await fetch(
        `${server.baseUrl}/v1/proxy/grant/not-a-real-grant`
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'GRANT_NOT_FOUND');
});

// ── 3. Health job → state update ─────────────────────────────────────────────

test('health check marks the addon unhealthy when its manifest fails', async () => {
    state.manifestStatus = 500;
    try {
        const trigger = await client.post('/v1/addons/health/check');
        assert.ok(
            [200, 202].includes(trigger.status),
            `health check accepted (${trigger.status})`
        );

        // Poll the management list until the failure is reflected.
        let unhealthy = false;
        for (let i = 0; i < 30 && !unhealthy; i++) {
            await new Promise((r) => setTimeout(r, 300));
            const list = await client.get('/v1/addons');
            const entry = list.body.addons.find((a) => a.id === PROVIDER_ID);
            unhealthy = entry?.health ? entry.health.healthy === false : false;
        }
        assert.ok(unhealthy, 'addon left the healthy set after the outage');
    } finally {
        state.manifestStatus = 200;
    }
});

test('service readiness reports concrete component checks', async () => {
    const res = await client.get('/health/ready');
    assert.equal(res.status, 200);
    assert.equal(res.body.ready, true);
    assert.ok(res.body.checks, 'readiness includes per-component checks');
});

// ── 4. Debrid configuration and redaction ────────────────────────────────────

test('debrid keys are stored but never echoed back', async () => {
    const SECRET = 'rd-e2e-secret-value-9f8e7d6c';
    const patch = await client.patch('/v1/settings/debrid', {
        provider: 'realdebrid',
        apiKey: SECRET,
        enabled: true
    });
    assert.ok(
        [200, 201].includes(patch.status),
        `patch debrid (${patch.status})`
    );

    const settings = await client.get('/v1/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.debrid.hasKey, true);
    assert.ok(!JSON.stringify(settings.body).includes(SECRET));

    const exported = await client.get('/v1/settings/export');
    assert.equal(exported.status, 200);
    assert.ok(!JSON.stringify(exported.body).includes(SECRET));
});

// ── 5. Graceful shutdown and restart ────────────────────────────────────────

test('graceful shutdown exits cleanly and state survives a restart', async () => {
    const dataFile = scratchFile('e2e-restart');

    const first = await bootSeededServer(dataFile);
    try {
        const c1 = createClient(first.baseUrl);
        await c1.login(ADMIN_TOKEN);
        const list = await c1.get('/v1/addons');
        assert.equal(list.status, 200);
        assert.ok(
            list.body.addons.some((a) => a.id === PROVIDER_ID),
            'seeded addon present before shutdown'
        );

        const code = await first.stop({ signal: 'SIGTERM', timeoutMs: 12_000 });
        assert.equal(code, 0, 'server exits cleanly on SIGTERM');
    } catch (err) {
        await first.proc.kill('SIGKILL');
        throw err;
    }

    // Restart on the same data file: the imported addon must still be there.
    // (No seed this time — seeds only run on an empty store.)
    const second = await startServer({
        dataFile,
        env: {
            adminToken: ADMIN_TOKEN,
            tmdbBaseUrl: `${tmdb.baseUrl}/3`
        }
    });
    try {
        const c2 = createClient(second.baseUrl);
        await c2.login(ADMIN_TOKEN);
        const list = await c2.get('/v1/addons');
        assert.equal(list.status, 200);
        assert.ok(
            list.body.addons.length >= 1,
            'addon persisted across restart'
        );
        assert.ok(
            list.body.addons.some((a) => a.id === PROVIDER_ID),
            'same provider id after restart'
        );
    } finally {
        await second.stop({ timeoutMs: 8000 });
        await fs.rm(dataFile, { force: true });
    }
});
