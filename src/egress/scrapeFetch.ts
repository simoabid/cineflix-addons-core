/**
 * Scrape egress proxy.
 *
 * When self-hosting on AWS/EC2 (or any datacenter), many Stremio addon backends
 * and their stream CDNs return 403 / 429 / empty bodies because they block
 * datacenter IPs. This module optionally routes outbound HTTP(S) requests through
 * a residential (or other) HTTP proxy so requests succeed from production.
 *
 * Because addon hosts are arbitrary (users install whatever they want), the
 * default mode is `all` — every request goes through the proxy when one is
 * configured, EXCEPT the control-plane hosts (TMDB, Stremio API) which are never
 * IP-blocked and would only waste metered residential bandwidth.
 *
 * Env:
 *   PROXY_URL | SCRAPE_PROXY_URL     HTTP proxy URL (http://user:pass@host:port)
 *   SCRAPE_PROXY_MODE                all | allowlist | off   (default: all)
 *   SCRAPE_PROXY_HOSTS               comma host suffixes to proxy (allowlist mode)
 *   SCRAPE_PROXY_DIRECT_HOSTS        comma host suffixes NEVER proxied
 *   SCRAPE_PROXY_FALLBACK_DIRECT     true|false — on proxy error, retry direct
 *                                    (default true, only for viaProxy:'auto')
 */
import {
    ProxyAgent,
    Agent,
    fetch as undiciFetch,
    type RequestInit as UndiciRequestInit
} from 'undici';
import { tracer, logger } from '../telemetry/index.js';
import { globalConcurrency } from '../concurrency/coordinator.js';

export type ScrapeProxyMode = 'off' | 'allowlist' | 'all';

export type ScrapeFetchInit = RequestInit & {
    /** auto = follow mode (default); true = always proxy; false = never proxy. */
    viaProxy?: boolean | 'auto';
    /** Abort after this many ms (sets signal if none provided). */
    timeoutMs?: number;
    /** Pin DNS to validated address to prevent rebinding (SSRF defense). */
    pinnedIp?: string;
    /** Whether to inject W3C traceparent header to upstream host (default false). */
    propagateTrace?: boolean;
};

/** Control-plane hosts that are never IP-blocked — keep them off the proxy. */
const DEFAULT_DIRECT_SUFFIXES = [
    'api.themoviedb.org',
    'image.tmdb.org',
    'themoviedb.org',
    'api.strem.io',
    'strem.io',
    'localhost',
    '127.0.0.1'
];

let agent: ProxyAgent | null | undefined;
let loggedStatus = false;

function envTruthy(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return defaultValue;
    return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function getScrapeProxyUrl(): string | null {
    const url =
        process.env.SCRAPE_PROXY_URL?.trim() ||
        process.env.PROXY_URL?.trim() ||
        '';
    return url || null;
}

export function getScrapeProxyMode(): ScrapeProxyMode {
    const raw = (process.env.SCRAPE_PROXY_MODE ?? 'all').trim().toLowerCase();
    if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled') {
        return 'off';
    }
    if (raw === 'allowlist') return 'allowlist';
    return 'all';
}

export function isScrapeProxyStreamEnabled(): boolean {
    return envTruthy('SCRAPE_PROXY_STREAM', true);
}

function parseSuffixes(name: string, defaults: string[] = []): string[] {
    const raw = process.env[name]?.trim();
    const extra = raw
        ? raw
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
        : [];
    return [...new Set([...defaults, ...extra])];
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
    const h = hostname.toLowerCase();
    const s = suffix.toLowerCase().replace(/^\./, '');
    return h === s || h.endsWith(`.${s}`);
}

export function isDirectHost(hostname: string): boolean {
    const suffixes = parseSuffixes(
        'SCRAPE_PROXY_DIRECT_HOSTS',
        DEFAULT_DIRECT_SUFFIXES
    );
    return suffixes.some((s) => hostMatchesSuffix(hostname, s));
}

export function shouldProxyHost(hostname: string): boolean {
    const mode = getScrapeProxyMode();
    if (mode === 'off' || !getScrapeProxyUrl()) return false;
    if (isDirectHost(hostname)) return false;
    if (mode === 'all') return true;
    // allowlist mode
    const suffixes = parseSuffixes('SCRAPE_PROXY_HOSTS');
    return suffixes.some((s) => hostMatchesSuffix(hostname, s));
}

export function shouldProxyUrl(
    url: string | URL,
    viaProxy: boolean | 'auto' = 'auto'
): boolean {
    if (viaProxy === false) return false;
    if (!getScrapeProxyUrl() || getScrapeProxyMode() === 'off') return false;
    try {
        const u = typeof url === 'string' ? new URL(url) : url;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        if (viaProxy === true) return !isDirectHost(u.hostname);
        return shouldProxyHost(u.hostname);
    } catch {
        return false;
    }
}

export function getAgent(): ProxyAgent | null {
    if (agent !== undefined) return agent;
    const proxyUrl = getScrapeProxyUrl();
    if (!proxyUrl || getScrapeProxyMode() === 'off') {
        agent = null;
        return agent;
    }
    try {
        agent = new ProxyAgent(proxyUrl);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[egress] Failed to create ProxyAgent: ${msg}`);
        agent = null;
    }
    return agent;
}

export function getScrapeProxyStatus(): {
    enabled: boolean;
    mode: ScrapeProxyMode;
    stream: boolean;
    proxyDisplay: string | null;
} {
    const proxyUrl = getScrapeProxyUrl();
    const mode = getScrapeProxyMode();
    let proxyDisplay: string | null = null;
    if (proxyUrl) {
        try {
            const u = new URL(proxyUrl);
            const auth = u.username ? `${u.username}@` : '';
            proxyDisplay = `${u.protocol}//${auth}${u.host}`;
        } catch {
            proxyDisplay = '(invalid PROXY_URL)';
        }
    }
    return {
        enabled: Boolean(proxyUrl) && mode !== 'off',
        mode,
        stream: isScrapeProxyStreamEnabled(),
        proxyDisplay
    };
}

export function logScrapeProxyStatus(prefix = '[egress]'): void {
    if (loggedStatus) return;
    loggedStatus = true;
    const s = getScrapeProxyStatus();
    if (!s.enabled) {
        logger.info(
            `${prefix} Scrape egress proxy OFF (set PROXY_URL to route around datacenter IP blocks)`,
            { component: 'egress', proxyEnabled: false }
        );
        return;
    }
    logger.info(
        `${prefix} Scrape egress proxy ON mode=${s.mode} stream=${s.stream} via ${s.proxyDisplay}`,
        {
            component: 'egress',
            proxyEnabled: true,
            mode: s.mode,
            stream: s.stream
        }
    );
}

/** Drop hop-by-hop / compressed body headers that confuse undici on replay. */
function normalizeHeaders(
    headers?: RequestInit['headers'],
    propagateTrace = false
): Record<string, string> | undefined {
    if (!headers && !propagateTrace) {
        return undefined;
    }
    const out: Record<string, string> = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((v, k) => {
            out[k] = v;
        });
    } else if (Array.isArray(headers)) {
        for (const pair of headers) {
            const [k, v] = pair;
            if (typeof k === 'string' && typeof v === 'string') out[k] = v;
        }
    } else if (headers) {
        for (const [k, v] of Object.entries(
            headers as Record<string, string>
        )) {
            if (typeof v === 'string') out[k] = v;
        }
    }
    delete out['accept-encoding'];
    delete out['Accept-Encoding'];
    if (propagateTrace) {
        tracer.injectTraceparent(out);
    }
    return out;
}

/**
 * Fetch that optionally routes through the scrape egress proxy.
 * Drop-in replacement for global `fetch` in addon HTTP calls.
 */
function createPinnedDispatcher(pinnedIp: string): Agent {
    // Pin DNS: override lookup to return the validated address regardless of
    // current DNS state (mitigates rebinding).
    const isV6 = pinnedIp.includes(':');
    return new Agent({
        connect: {
            lookup: (
                _hostname: string,
                _opts: unknown,
                cb: (err: Error | null, address: string, family: number) => void
            ) => {
                cb(null, pinnedIp, isV6 ? 6 : 4);
            }
        }
    });
}

export async function scrapeFetch(
    input: string | URL | { url: string },
    init?: ScrapeFetchInit
): Promise<Response> {
    const {
        viaProxy = 'auto',
        timeoutMs,
        pinnedIp,
        propagateTrace: optPropagateTrace,
        ...rest
    } = init ?? {};

    let urlStr: string;
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.href;
    else urlStr = input.url;

    let upstreamHost = 'unknown';
    try {
        upstreamHost = new URL(urlStr).hostname;
    } catch {
        // invalid URL string, fallback to 'unknown'
    }

    // Phase 7 §10.1 — per-host outbound concurrency bound. scrapeFetch is the
    // single choke point for all outbound HTTP (secureFetch delegates here),
    // so every class of remote work (manifests, streams, imports, proxy
    // upstreams) is capped per hostname no matter which pool initiated it.
    if (upstreamHost !== 'unknown') {
        return globalConcurrency.withHostSlot(upstreamHost, () =>
            doFetch(urlStr, rest, {
                viaProxy,
                timeoutMs,
                pinnedIp,
                optPropagateTrace,
                upstreamHost
            })
        );
    }
    return doFetch(urlStr, rest, {
        viaProxy,
        timeoutMs,
        pinnedIp,
        optPropagateTrace,
        upstreamHost
    });
}

async function doFetch(
    urlStr: string,
    rest: Omit<
        ScrapeFetchInit,
        'viaProxy' | 'timeoutMs' | 'pinnedIp' | 'propagateTrace'
    >,
    ctx: {
        viaProxy: boolean | 'auto';
        timeoutMs?: number;
        pinnedIp?: string;
        optPropagateTrace?: boolean;
        upstreamHost: string;
    }
): Promise<Response> {
    const { viaProxy, timeoutMs, pinnedIp, optPropagateTrace, upstreamHost } =
        ctx;

    return tracer.withSpan(
        'http.client.request',
        async (span) => {
            span.setAttribute('http.method', rest.method || 'GET');
            span.setAttribute('http.url.host', upstreamHost);

            let signal = rest.signal;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            if (!signal && timeoutMs != null && timeoutMs > 0) {
                const ac = new AbortController();
                signal = ac.signal;
                timeout = setTimeout(() => ac.abort(), timeoutMs);
            }

            const propagateTrace =
                optPropagateTrace ??
                process.env.TRACING_PROPAGATE_TO_UPSTREAM === 'true';
            const useProxy = shouldProxyUrl(urlStr, viaProxy);
            span.setAttribute('http.use_proxy', useProxy);
            const headers = normalizeHeaders(rest.headers, propagateTrace);

            try {
                // DNS-pinned requests MUST bypass the egress proxy: the proxy would
                // resolve the hostname itself, ignoring the validated IP and re-introducing
                // SSRF/DNS-rebinding. When pinnedIp is set, use the pinned dispatcher directly.
                if (pinnedIp) {
                    const pinnedDispatcher = createPinnedDispatcher(pinnedIp);
                    try {
                        const undiciInit: UndiciRequestInit = {
                            method: rest.method,
                            headers,
                            body: rest.body as UndiciRequestInit['body'],
                            signal: signal as UndiciRequestInit['signal'],
                            redirect: rest.redirect,
                            dispatcher: pinnedDispatcher
                        };
                        const res = (await undiciFetch(
                            urlStr,
                            undiciInit
                        )) as unknown as Response;
                        span.setAttribute('http.status_code', res.status);
                        span.setStatus(res.ok ? 'ok' : 'error');
                        return res;
                    } finally {
                        void pinnedDispatcher.close?.().catch(() => undefined);
                    }
                }

                if (useProxy) {
                    const dispatcher = getAgent();
                    if (dispatcher) {
                        const undiciInit: UndiciRequestInit = {
                            method: rest.method,
                            headers,
                            body: rest.body as UndiciRequestInit['body'],
                            signal: signal as UndiciRequestInit['signal'],
                            redirect: rest.redirect,
                            dispatcher
                        };
                        try {
                            const res = (await undiciFetch(
                                urlStr,
                                undiciInit
                            )) as unknown as Response;
                            span.setAttribute('http.status_code', res.status);
                            span.setStatus(res.ok ? 'ok' : 'error');
                            return res;
                        } catch (err) {
                            const allowFallback = !/^(0|false|off|no)$/i.test(
                                (
                                    process.env.SCRAPE_PROXY_FALLBACK_DIRECT ??
                                    'true'
                                ).trim()
                            );
                            if (viaProxy === true || !allowFallback) {
                                throw wrapProxyError(err, urlStr);
                            }
                            // auto mode: fall through to a direct attempt below
                        }
                    }
                }

                const res = await fetch(urlStr, { ...rest, headers, signal });
                span.setAttribute('http.status_code', res.status);
                span.setStatus(res.ok ? 'ok' : 'error');
                return res;
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        },
        {
            attributes: {
                'http.method': rest.method || 'GET',
                'http.url.host': upstreamHost
            }
        }
    );
}

function wrapProxyError(err: unknown, url: string): Error {
    const chain: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 6 && cur; i++) {
        if (cur instanceof Error) {
            chain.push(cur.message);
            cur = (cur as Error & { cause?: unknown }).cause;
        } else {
            chain.push(String(cur));
            break;
        }
    }
    const joined = chain.join(' | ');
    if (/407|Proxy Authentication/i.test(joined)) {
        return new Error(
            `egress proxy auth failed (HTTP 407) for ${url} — check PROXY_URL credentials`
        );
    }
    return err instanceof Error
        ? err
        : new Error(`egress proxy error for ${url}: ${joined}`);
}

/** Convenience: GET JSON (null on failure). */
export async function scrapeFetchJson<T = unknown>(
    url: string,
    headers?: Record<string, string>,
    init?: ScrapeFetchInit
): Promise<T | null> {
    try {
        const res = await scrapeFetch(url, {
            headers: { Accept: 'application/json', ...headers },
            timeoutMs: 15_000,
            ...init
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

/** Test helper: reset cached agent (e.g. after env change). */
export function resetScrapeProxyAgent(): void {
    if (agent) void agent.close().catch(() => undefined);
    agent = undefined;
    loggedStatus = false;
}

/**
 * Phase 7 §10.2 — close all egress agents at shutdown so in-flight proxied
 * sockets don't keep the event loop alive past the grace period.
 */
export async function closeEgress(): Promise<void> {
    if (agent) {
        try {
            await agent.close();
        } catch {
            /* ignore */
        }
        agent = null;
    }
}
