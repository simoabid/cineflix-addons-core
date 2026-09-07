/**
 * Subtitle aggregate integration tests (Phase 12 §15.2).
 *
 * Runs aggregateSubtitles against the real AddonManager + a fake Stremio
 * addon (loopback) and a fake fallback provider, covering:
 *   - provenance + canonical language labels on results
 *   - hearingImpaired=avoid/only filtering through the HTTP-shaped pipeline
 *   - trusted fallback activation only when addons return nothing
 *   - template guard rails (SSRF policy rejects non-allowlisted fallback)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import {
    devConfig,
    scratchFile,
    startFakeAddonServer
} from './helpers/harness.js';
import { FileStorageBackend } from '../dist/storage/file/index.js';
import { AddonManager } from '../dist/addons/manager.js';
import { aggregateSubtitles } from '../dist/subtitles/index.js';

const DATA_FILE = scratchFile('subs-exp-integration');
let addon;
let fallbackAddon;
let storage;
let manager;

const MANIFEST = {
    id: 'org.subs.addon',
    version: '1.0.0',
    name: 'Subs Addon',
    resources: ['stream', 'subtitles'],
    types: ['movie', 'series']
};

const SUBS = [
    {
        id: 'en-sdh',
        url: 'https://cdn.example/movie.en.sdh.srt',
        lang: 'en'
    },
    {
        id: 'fr-plain',
        url: 'https://cdn.example/movie.fr.srt',
        lang: 'fr'
    },
    {
        id: 'en-plain-dup',
        url: 'https://cdn.example/movie.en.srt',
        lang: 'English'
    }
];

/** Fresh manager over a fresh storage file with one seeded addon. */
async function makeManager(baseUrl, fileSuffix) {
    const file = scratchFile(`subs-exp-${fileSuffix}`);
    await fs.rm(file, { force: true });
    const st = new FileStorageBackend(file);
    await st.init();
    await st.saveAddon({
        providerId: 'addon:org-subs-addon',
        slug: 'org-subs-addon',
        name: 'Subs Addon',
        manifestUrl: `${baseUrl}/manifest.json`,
        baseUrl,
        enabled: true,
        order: 0,
        timeoutMs: 5000,
        source: 'manual',
        manifest: MANIFEST,
        version: 1,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    // Dev-only SSRF exemption: reach loopback fake upstreams over HTTP.
    const cfg = devConfig();
    const fakeRegistry = {
        hasProvider: () => false,
        register: () => {},
        unregister: () => {},
        listProviders: () => [],
        getProviders: () => []
    };
    const mgr = AddonManager.create(fakeRegistry, cfg, st);
    await mgr.init();
    return mgr;
}

before(async () => {
    addon = await startFakeAddonServer({
        manifest: MANIFEST,
        subtitlesFor: () => SUBS
    });
    // Fallback provider serving a different subtitle when addons return none.
    fallbackAddon = await startFakeAddonServer({
        manifest: { id: 'org.fallback', version: '1.0.0', name: 'FB' },
        subtitlesFor: () => [
            { id: 'fb-es', url: 'https://fb.example/es.srt', lang: 'spa' }
        ]
    });
    storage = null; // per-test managers own their storage
    manager = await makeManager(addon.baseUrl, 'main');
});

after(async () => {
    await addon.close();
    await fallbackAddon.close();
});

const BASE_OPTS = {
    secureProxy: false, // legacy path: no grant issuance needed in-process
    fallback: {
        enabled: false,
        policy: {
            allowHttp: true,
            allowHostSuffixes: ['127.0.0.1']
        }
    }
};

test('aggregation returns provenance, canonical lang, and ranked order', async () => {
    const res = await aggregateSubtitles(
        manager,
        'https://public.example',
        { imdbId: 'tt0111161', language: 'en' },
        BASE_OPTS
    );
    assert.equal(res.addonsQueried, 1);
    assert.equal(res.source, 'stremio-addons');
    assert.ok(res.subtitles.length >= 1);

    // Language preference: only English-tagged entries survive.
    for (const s of res.subtitles) {
        assert.equal(s.lang, 'en');
        assert.equal(s.provenance, 'addon:org-subs-addon');
        assert.equal(s.origin, 'addon');
        assert.equal(s.label, 'English');
        assert.equal(typeof s.score, 'number');
    }
    // Highest score first: SDH entry earns the accessibility boost.
    assert.equal(res.subtitles[0].hearingImpaired, true);
    assert.equal(res.subtitles[0].url.includes('/v1/proxy?data='), true);
});

test('hearingImpaired=avoid drops SDH tracks; only keeps just them', async () => {
    const avoid = await aggregateSubtitles(
        manager,
        'https://public.example',
        { imdbId: 'tt0111161', hearingImpaired: 'avoid' },
        BASE_OPTS
    );
    assert.equal(
        avoid.subtitles.some((s) => s.hearingImpaired),
        false
    );
    assert.ok(avoid.subtitles.length >= 1);

    const only = await aggregateSubtitles(
        manager,
        'https://public.example',
        { imdbId: 'tt0111161', hearingImpaired: 'only' },
        BASE_OPTS
    );
    assert.ok(only.subtitles.length >= 1);
    for (const s of only.subtitles) assert.equal(s.hearingImpaired, true);
});

test('fallback activates only when addons return nothing and is provenance-tagged', async () => {
    const emptyAddon = await startFakeAddonServer({
        manifest: MANIFEST,
        subtitlesFor: () => []
    });
    try {
        const emptyManager = await makeManager(emptyAddon.baseUrl, 'empty-fb');
        const res = await aggregateSubtitles(
            emptyManager,
            'https://public.example',
            { imdbId: 'tt0111161' },
            {
                ...BASE_OPTS,
                fallback: {
                    enabled: true,
                    template: `${fallbackAddon.baseUrl}/subtitles/movie/tt{{imdbId}}.json`,
                    policy: {
                        allowHttp: true,
                        allowHostSuffixes: ['127.0.0.1']
                    }
                }
            }
        );
        assert.equal(res.fallbackUsed, true);
        assert.equal(res.source, 'fallback');
        assert.ok(res.subtitles.length >= 1);
        assert.equal(res.subtitles[0].origin, 'fallback');
        assert.equal(res.subtitles[0].lang, 'es');

        // Without fallback enabled: same query returns nothing.
        const none = await aggregateSubtitles(
            emptyManager,
            'https://public.example',
            { imdbId: 'tt0111161' },
            BASE_OPTS
        );
        assert.equal(none.subtitles.length, 0);
        assert.equal(none.fallbackUsed, undefined);
    } finally {
        await emptyAddon.close();
    }
});

test('fallback template that violates policy yields no results (fail closed)', async () => {
    const emptyAddon = await startFakeAddonServer({
        manifest: MANIFEST,
        subtitlesFor: () => []
    });
    try {
        const emptyManager = await makeManager(
            emptyAddon.baseUrl,
            'empty-nofb'
        );
        // Policy without the loopback suffix exemption → fetch is rejected.
        const res = await aggregateSubtitles(
            emptyManager,
            'https://public.example',
            { imdbId: 'tt0111161' },
            {
                ...BASE_OPTS,
                fallback: {
                    enabled: true,
                    template: `${fallbackAddon.baseUrl}/subtitles/movie/tt{{imdbId}}.json`
                }
            }
        );
        assert.equal(res.subtitles.length, 0);
        assert.equal(res.fallbackUsed, undefined);
    } finally {
        await emptyAddon.close();
    }
});
