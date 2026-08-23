/**
 * Shared zero-dependency test harness (Phase 9 §12.1).
 *
 * Consolidates the per-file boilerplate that 60+ suites had duplicated:
 * scratch-file management under the git-ignored `data/` directory, a
 * development-bypass AppConfig for reaching local fake upstreams (mirrors how
 * dev instances reach local addons — production never allows this), fake
 * provider registries, and a configurable fake Stremio addon HTTP server.
 *
 * Everything runs on node:test + node:assert/strict — no third-party framework.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import fastify from 'fastify';
import { loadConfig } from '../../dist/config.js';

// ── scratch files ────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve('./data');

/** Absolute path for a git-ignored scratch file: data/test-<name>.json */
export function scratchFile(name) {
    return path.join(DATA_DIR, `test-${name}.json`);
}

/** Best-effort removal; safe when the file never existed. */
export async function removeScratch(file) {
    try {
        await fs.unlink(file);
    } catch {
        /* ignore */
    }
}

// ── config ───────────────────────────────────────────────────────────────────

/**
 * Development config that can reach local fake upstreams.
 *
 * `allowHttpUpstreams` + `outboundHostAllowSuffixes: ['127.0.0.1']` is the
 * documented dev-only SSRF exemption: `urlPolicy` hard-codes that suffix
 * exemptions never bypass private/loopback blocking in production.
 */
export function devConfig(overrides = {}) {
    return {
        ...loadConfig(),
        authMode: 'disabled',
        allowHttpUpstreams: true,
        outboundHostAllowSuffixes: ['127.0.0.1'],
        ...overrides
    };
}

// ── fake OMSS provider registry ──────────────────────────────────────────────

export function createFakeRegistry() {
    const providers = new Map();
    return {
        register(provider) {
            providers.set(provider.id, provider);
        },
        unregister(id) {
            providers.delete(id);
        },
        hasProvider(id) {
            return providers.has(id);
        },
        getProvider(id) {
            return providers.get(id);
        },
        getProviders() {
            return [...providers.values()];
        },
        listProviders() {
            return [...providers.keys()];
        }
    };
}

// ── HTTP servers ─────────────────────────────────────────────────────────────

/** Start a raw HTTP server on an ephemeral loopback port. */
export function startHttpServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                close: () =>
                    new Promise((res) => server.close(() => res()))
            });
        });
    });
}

/**
 * Minimal valid Stremio manifest for fake upstreams.
 * `overrides` replaces/adds top-level fields.
 */
export function fakeManifest(overrides = {}) {
    return {
        id: 'org.fake.addon',
        version: '1.0.0',
        name: 'Fake Addon',
        description: 'Phase 9 fake upstream',
        resources: ['stream', 'subtitles'],
        types: ['movie', 'series'],
        ...overrides
    };
}

/**
 * Fake Stremio addon server. Serves:
 *   GET /manifest.json                      → options.manifest (or default)
 *   GET /stream/:type/:id.json              → options.streamsFor(type,id) ?? []
 *   GET /subtitles/:type/:id.json           → options.subtitlesFor(type,id) ?? []
 *
 * Behavior hooks (all optional):
 *   manifestStatus   — status code for /manifest.json (default 200)
 *   manifestBody     — raw string body for /manifest.json (malformed JSON etc.)
 *   delayMs          — artificial response latency
 *   maxBytesHit      — called when a body exceeds the client limit upstream-side
 *   onStream         — (req, res, type, id, query) => void custom handler
 */
export function startFakeAddonServer(options = {}) {
    const manifest = options.manifest ?? fakeManifest();
    const seen = { streams: [], subtitles: [], manifests: 0 };
    return startHttpServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const send = (status, body, headers = {}) => {
            const payload =
                typeof body === 'string' ? body : JSON.stringify(body);
            if (options.delayMs) {
                setTimeout(() => {
                    if (res.writableEnded) return;
                    res.writeHead(status, {
                        'content-type': 'application/json',
                        ...headers
                    });
                    res.end(payload);
                }, options.delayMs);
            } else {
                res.writeHead(status, {
                    'content-type': 'application/json',
                    ...headers
                });
                res.end(payload);
            }
        };

        if (u.pathname === '/manifest.json' || u.pathname.endsWith('/manifest.json')) {
            seen.manifests++;
            if (options.manifestBody !== undefined) {
                return send(options.manifestStatus ?? 200, options.manifestBody);
            }
            return send(options.manifestStatus ?? 200, manifest);
        }
        const stream = u.pathname.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
        if (stream) {
            seen.streams.push({
                type: decodeURIComponent(stream[1]),
                id: decodeURIComponent(stream[2]),
                query: u.search,
                ua: req.headers['user-agent']
            });
            if (options.onStream) {
                return options.onStream(req, res, stream[1], stream[2], u);
            }
            const body = options.streamsFor
                ? options.streamsFor(decodeURIComponent(stream[1]), decodeURIComponent(stream[2]), u)
                : [];
            return send(200, { streams: body });
        }
        const subs = u.pathname.match(/^\/subtitles\/([^/]+)\/(.+)\.json$/);
        if (subs) {
            seen.subtitles.push({
                type: decodeURIComponent(subs[1]),
                id: decodeURIComponent(subs[2]),
                query: u.search
            });
            const body = options.subtitlesFor
                ? options.subtitlesFor(decodeURIComponent(subs[1]), decodeURIComponent(subs[2]), u)
                : [];
            return send(200, { subtitles: body });
        }
        send(404, { error: 'Not found' });
    }).then((handle) => ({ ...handle, seen, manifestUrl: `${handle.baseUrl}/manifest.json` }));
}

// ── fastify app factory ──────────────────────────────────────────────────────

/**
 * Boot a bare Fastify instance with the given route registrar applied.
 * Always uses logger:false to keep test output readable.
 */
export async function buildApp(register) {
    const app = fastify({ logger: false });
    if (register) await register(app);
    await app.ready();
    return app;
}

/** Inject a JSON GET and parse the payload; returns { status, headers, body }. */
export async function getJson(app, url, headers = {}) {
    const res = await app.inject({ method: 'GET', url, headers });
    let body = null;
    try {
        body = JSON.parse(res.payload);
    } catch {
        body = res.payload;
    }
    return { status: res.statusCode, headers: res.headers, body };
}
