/**
 * E2E helper — boots the real compiled server (`dist/server.js`) as a child
 * process against fake upstreams, per Phase 9 §12.1 "run the built artifact".
 *
 * This is the process-level equivalent of running the container: the full
 * composition root (storage, jobs, health, proxy grants, auth, admin UI)
 * comes up exactly as in production wiring, only with development-safe env
 * so loopback fake upstreams are reachable.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// test/e2e/helpers/ → repo root is three levels up.
const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);
const SERVER_ENTRY = path.join(ROOT, 'dist', 'server.js');

/** Ask the OS for a free TCP port (small TOCTOU race, acceptable for tests). */
export function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/** Poll an HTTP endpoint until it returns 200 or the deadline passes. */
async function waitUntilReady(url, timeoutMs, log) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
            if (res.ok) return;
            lastErr = `HTTP ${res.status}`;
        } catch (err) {
            lastErr = err?.message ?? String(err);
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
        `server did not become ready within ${timeoutMs}ms (${lastErr})\n${log}`
    );
}

/**
 * Boot dist/server.js with development-safe env.
 *
 * Returns { proc, port, baseUrl, dataFile, logs, stop() }.
 */
export async function startServer({
    dataFile,
    port,
    env = {},
    readyTimeoutMs = 20_000
} = {}) {
    const actualPort = port ?? (await getFreePort());
    const childEnv = {
        ...process.env,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(actualPort),
        TMDB_API_KEY: env.tmdbApiKey ?? 'e2e-fake-key',
        LOG_LEVEL: 'fatal',
        AUDIT_ENABLED: 'false',
        // Dev-only SSRF exemption: allow plain HTTP + loopback fake upstreams.
        ALLOW_HTTP_UPSTREAMS: 'true',
        OUTBOUND_HOST_ALLOW_SUFFIXES: '127.0.0.1',
        TERMINATION_GRACE_PERIOD_MS: '4000',
        ...(env.tmdbBaseUrl ? { TMDB_API_BASE_URL: env.tmdbBaseUrl } : {}),
        ...(env.adminToken
            ? { ADMIN_TOKEN: env.adminToken, AUTH_MODE: 'static-token' }
            : {}),
        ...(dataFile ? { ADDONS_DATA_FILE: dataFile } : {}),
        ...Object.fromEntries(
            Object.entries(env.extra ?? {}).map(([k, v]) => [k, String(v)])
        )
    };

    const proc = spawn(process.execPath, [SERVER_ENTRY], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ROOT
    });

    let logs = '';
    proc.stdout.on('data', (d) => {
        logs += d.toString();
    });
    proc.stderr.on('data', (d) => {
        logs += d.toString();
    });

    const baseUrl = `http://127.0.0.1:${actualPort}`;
    try {
        await waitUntilReady(`${baseUrl}/health/live`, readyTimeoutMs, logs);
    } catch (err) {
        proc.kill('SIGKILL');
        throw err;
    }

    return {
        proc,
        port: actualPort,
        baseUrl,
        logs: () => logs,
        /** Stop gracefully; resolves with the exit code (null on force-kill). */
        stop({ signal = 'SIGTERM', timeoutMs = 10_000 } = {}) {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (code) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(killer);
                    resolve(code);
                };
                const killer = setTimeout(() => {
                    proc.kill('SIGKILL');
                }, timeoutMs);
                proc.once('exit', (code) => finish(code));
                proc.kill(signal);
            });
        }
    };
}

/**
 * Minimal fetch client with a cookie jar + CSRF header handling so the
 * session-based management API can be exercised like the admin UI does.
 */
export function createClient(baseUrl) {
    const jar = new Map(); // name -> value
    let csrfToken = null;

    function storeCookies(res) {
        const raw = res.headers.getSetCookie?.() ?? [];
        for (const line of raw) {
            const [pair] = line.split(';');
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            // Deleted cookies arrive as name=; treat empty as removal.
            if (value === '') jar.delete(name);
            else jar.set(name, value);
        }
    }

    async function request(method, pathname, { body, headers = {} } = {}) {
        const cookieHeader =
            [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') ||
            undefined;
        const finalHeaders = { ...headers };
        if (body !== undefined && finalHeaders['content-type'] === undefined) {
            finalHeaders['content-type'] = 'application/json';
        }
        if (cookieHeader) finalHeaders.cookie = cookieHeader;
        if (
            csrfToken &&
            !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
            !pathname.startsWith('/v1/auth/login')
        ) {
            finalHeaders['x-csrf-token'] = csrfToken;
        }
        const res = await fetch(`${baseUrl}${pathname}`, {
            method,
            headers: finalHeaders,
            body:
                body === undefined
                    ? undefined
                    : typeof body === 'string'
                      ? body
                      : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000)
        });
        storeCookies(res);
        let payload = null;
        const text = await res.text();
        try {
            payload = JSON.parse(text);
        } catch {
            payload = text;
        }
        return { status: res.status, headers: res.headers, body: payload };
    }

    return {
        request,
        /** Cookie jar (Map name -> value) — exposed for raw-fetch assertions. */
        jar,
        get: (p, o) => request('GET', p, o),
        post: (p, body, o) =>
            request('POST', p, {
                ...o,
                body,
                headers: { ...(o?.headers ?? {}) }
            }),
        patch: (p, body, o) => request('PATCH', p, { ...o, body }),
        del: (p, o) => request('DELETE', p, o),

        /**
         * Login with a static admin token; captures session + CSRF cookies.
         * Returns the login response.
         */
        async login(token) {
            const res = await request('POST', '/v1/auth/login', {
                body: { token },
                headers: { 'content-type': 'application/json' }
            });
            csrfToken = res.body?.csrfToken ?? null;
            return res;
        },

        logout() {
            csrfToken = null;
            return request('POST', '/v1/auth/logout', {
                headers: { 'content-type': 'application/json' }
            });
        }
    };
}
