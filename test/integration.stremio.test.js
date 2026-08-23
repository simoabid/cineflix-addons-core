/**
 * Phase 9 §12.1 integration tests — the Stremio protocol client against a
 * real local HTTP server: manifests (valid, malformed, slow, oversized,
 * redirects), stream fetches (query-configured transports, cacheMaxAge
 * propagation, error taxonomy) and subtitle fetch failure semantics.
 *
 * SSRF: loopback is reachable only through the documented dev exemption
 * (allowHttpUpstreams + outboundHostAllowSuffixes), mirroring local dev.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchManifest,
    fetchStreams,
    fetchSubtitles,
    StremioAddonError
} from '../dist/stremio/client.js';
import { UrlPolicyError } from '../dist/security/urlPolicy.js';
import {
    devConfig,
    fakeManifest,
    startFakeAddonServer,
    startHttpServer
} from './helpers/harness.js';

const POLICY = {
    allowHttp: true,
    allowHostSuffixes: ['127.0.0.1'],
    allowCredentials: false
};

test('fetchManifest returns the parsed manifest with a usable baseUrl', async () => {
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.it.manifest' })
    });
    try {
        const res = await fetchManifest(upstream.manifestUrl, 5000, {
            policy: POLICY
        });
        assert.equal(res.manifest.id, 'org.it.manifest');
        assert.equal(res.baseUrl, upstream.baseUrl);
        assert.equal(res.manifestUrl, upstream.manifestUrl);
    } finally {
        await upstream.close();
    }
});

test('query-configured transport URLs keep their configuration on baseUrl', async () => {
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.it.configured' })
    });
    try {
        const configured = `${upstream.manifestUrl}?cfg=eyJ1c2VyIjoiYWJjIn0`;
        const res = await fetchManifest(configured, 5000, { policy: POLICY });
        // The configuration query must survive onto the resource base URL
        assert.ok(
            res.baseUrl.endsWith('?cfg=eyJ1c2VyIjoiYWJjIn0'),
            `baseUrl kept config: ${res.baseUrl}`
        );

        // And stream requests must carry the configuration to the addon
        await fetchStreams(res.baseUrl, 'movie', 'tt0133093', 5000, {
            policy: POLICY
        });
        assert.equal(upstream.seen.streams.length, 1);
        assert.equal(
            upstream.seen.streams[0].query,
            '?cfg=eyJ1c2VyIjoiYWJjIn0'
        );
    } finally {
        await upstream.close();
    }
});

test('malformed JSON manifests fail with a clear client error', async () => {
    const upstream = await startFakeAddonServer({
        manifestBody: '{{{ not json'
    });
    try {
        await assert.rejects(
            () => fetchManifest(upstream.manifestUrl, 5000, { policy: POLICY }),
            (err) => {
                assert.ok(err instanceof StremioAddonError);
                assert.match(err.message, /not valid JSON/);
                return true;
            }
        );
    } finally {
        await upstream.close();
    }
});

test('manifests missing the required id field are rejected', async () => {
    const upstream = await startFakeAddonServer({
        manifestBody: JSON.stringify({ name: 'no id' })
    });
    try {
        await assert.rejects(
            () => fetchManifest(upstream.manifestUrl, 5000, { policy: POLICY }),
            (err) =>
                err instanceof StremioAddonError &&
                /missing required 'id'/.test(err.message)
        );
    } finally {
        await upstream.close();
    }
});

test('slow upstreams are cut off by the client timeout', async () => {
    const upstream = await startFakeAddonServer({ delayMs: 1000 });
    try {
        await assert.rejects(
            () => fetchManifest(upstream.manifestUrl, 150, { policy: POLICY }),
            (err) => err instanceof Error
        );
    } finally {
        await upstream.close();
    }
});

test('oversized manifest bodies are rejected before buffering completes', async () => {
    const upstream = await startHttpServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"' + 'a'.repeat(64 * 1024) + '"}');
    });
    try {
        await assert.rejects(
            () =>
                fetchManifest(`${upstream.baseUrl}/manifest.json`, 5000, {
                    maxBytes: 1024,
                    policy: POLICY
                }),
            (err) => err instanceof Error
        );
    } finally {
        await upstream.close();
    }
});

test('same-host redirects are followed; redirects into private space are blocked', async () => {
    const upstream = await startHttpServer((req, res) => {
        if (req.url.startsWith('/hop')) {
            res.writeHead(302, { location: '/manifest.json' });
            return res.end();
        }
        if (req.url.startsWith('/evil')) {
            // Redirect chain that lands on a private-network host — classic SSRF
            res.writeHead(302, {
                location: 'https://192.168.0.1/manifest.json'
            });
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fakeManifest({ id: 'org.it.redirects' })));
    });
    try {
        // Safe: same-origin hop
        const ok = await fetchManifest(`${upstream.baseUrl}/hop`, 5000, {
            policy: POLICY
        });
        assert.equal(ok.manifest.id, 'org.it.redirects');

        // Blocked: hop into RFC1918 space
        await assert.rejects(
            () =>
                fetchManifest(`${upstream.baseUrl}/evil`, 5000, {
                    policy: POLICY
                }),
            (err) => {
                assert.ok(
                    err instanceof UrlPolicyError ||
                        err instanceof StremioAddonError,
                    `unexpected error type: ${err}`
                );
                return true;
            }
        );
    } finally {
        await upstream.close();
    }
});

test('plain-HTTP upstreams are refused without the explicit dev exemption', async () => {
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.it.http' })
    });
    try {
        const strictPolicy = { allowHttp: false, allowCredentials: false };
        await assert.rejects(
            () =>
                fetchManifest(upstream.manifestUrl, 5000, {
                    policy: strictPolicy
                }),
            (err) => {
                assert.ok(
                    err instanceof UrlPolicyError ||
                        err instanceof StremioAddonError
                );
                return true;
            }
        );
    } finally {
        await upstream.close();
    }
});

test('fetchStreams returns stream arrays and propagates response cacheMaxAge non-enumerably', async () => {
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest({ id: 'org.it.streams' }),
        streamsFor: () => [
            {
                name: '1080p',
                url: 'https://cdn.example/video.mp4',
                title: 'Big Buck 1080p'
            },
            {
                name: 'torrent',
                infoHash: '0123456789abcdef0123456789abcdef01234567'
            }
        ],
        onStream: (req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    streams: [
                        { name: '1080p', url: 'https://cdn.example/video.mp4' }
                    ],
                    cacheMaxAge: 777
                })
            );
        }
    });
    try {
        const streams = await fetchStreams(
            upstream.baseUrl,
            'movie',
            'tt0133093',
            5000,
            {
                policy: POLICY
            }
        );
        assert.equal(streams.length, 1);
        assert.equal(streams[0].url, 'https://cdn.example/video.mp4');
        // cacheMaxAge is attached from the response body, non-enumerably
        const descriptor = Object.getOwnPropertyDescriptor(
            streams,
            'cacheMaxAge'
        );
        assert.ok(descriptor, 'cacheMaxAge descriptor present');
        assert.equal(descriptor.enumerable, false);
        assert.equal(descriptor.value, 777);
        assert.equal(upstream.seen.streams[0].id, 'tt0133093');
        assert.equal(upstream.seen.streams[0].type, 'movie');
        assert.match(
            upstream.seen.streams[0].ua,
            /Mozilla|Chrome/,
            'client identifies as a browser'
        );
    } finally {
        await upstream.close();
    }
});

test('fetchStreams surfaces HTTP errors as StremioAddonError', async () => {
    const upstream = await startFakeAddonServer({
        manifest: fakeManifest(),
        onStream: (_req, res) => {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end('{}');
        }
    });
    try {
        await assert.rejects(
            () =>
                fetchStreams(upstream.baseUrl, 'movie', 'tt0000001', 5000, {
                    policy: POLICY
                }),
            (err) =>
                err instanceof StremioAddonError && /HTTP 503/.test(err.message)
        );
    } finally {
        await upstream.close();
    }
});

test('fetchSubtitles never throws: errors degrade to an empty list', async () => {
    const dead = { baseUrl: 'http://127.0.0.1:1' }; // nothing listens on port 1
    const subs = await fetchSubtitles(dead.baseUrl, 'movie', 'tt0000001', 500, {
        policy: POLICY
    });
    assert.deepEqual(subs, []);

    const upstream = await startFakeAddonServer({
        manifest: fakeManifest(),
        subtitlesFor: () => [
            { url: 'https://subs.example/1.vtt', lang: 'english' },
            { url: 'https://subs.example/2.srt', lang: 'french' }
        ]
    });
    try {
        const ok = await fetchSubtitles(
            upstream.baseUrl,
            'movie',
            'tt0000002',
            5000,
            {
                policy: POLICY
            }
        );
        assert.equal(ok.length, 2);
        assert.equal(ok[0].lang, 'english');
    } finally {
        await upstream.close();
    }
});

test('credentials embedded in transport URLs are stripped by URL normalization and never reach the wire', async () => {
    let sawAuthHeader = null;
    let sawUrl = null;
    const upstream = await startHttpServer((req, res) => {
        sawAuthHeader = req.headers.authorization ?? null;
        sawUrl = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fakeManifest({ id: 'org.it.creds' })));
    });
    try {
        const credentialed = `${upstream.baseUrl}/manifest.json`.replace(
            'http://',
            'http://user:pass@'
        );
        const res = await fetchManifest(credentialed, 5000, { policy: POLICY });
        assert.equal(res.manifest.id, 'org.it.creds');
        // The credential neither reaches the request URL nor becomes an
        // Authorization header — normalization drops it before transport.
        assert.equal(sawUrl, '/manifest.json');
        assert.equal(sawAuthHeader, null);
        assert.ok(
            !res.baseUrl.includes('user:pass'),
            'baseUrl must not carry credentials'
        );
    } finally {
        await upstream.close();
    }
});
