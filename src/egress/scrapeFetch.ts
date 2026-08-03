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
    fetch as undiciFetch,
    type RequestInit as UndiciRequestInit
} from 'undici';

export type ScrapeProxyMode = 'off' | 'allowlist' | 'all';

export type ScrapeFetchInit = RequestInit & {
    /** auto = follow mode (default); true = always proxy; false = never proxy. */
    viaProxy?: boolean | 'auto';
    /** Abort after this many ms (sets signal if none provided). */
    timeoutMs?: number;
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
        console.log(
            `${prefix} egress proxy OFF (set PROXY_URL to route around datacenter IP blocks)`
        );
        return;
    }
    console.log(
        `${prefix} egress proxy ON mode=${s.mode} stream=${s.stream} via ${s.proxyDisplay}`
    );
}

/** Drop hop-by-hop / compressed body headers that confuse undici on replay. */
function normalizeHeaders(
    headers?: RequestInit['headers']
): Record<string, string> | undefined {
    if (!headers) return undefined;
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
    } else {
        for (const [k, v] of Object.entries(
            headers as Record<string, string>
        )) {
            if (typeof v === 'string') out[k] = v;
        }
    }
    delete out['accept-encoding'];
    delete out['Accept-Encoding'];
    return out;
}

/**
 * Fetch that optionally routes through the scrape egress proxy.
 * Drop-in replacement for global `fetch` in addon HTTP calls.
 */
export async function scrapeFetch(
    input: string | URL | Request,
    init: ScrapeFetchInit = {}
): Promise<Response> {
    const { viaProxy = 'auto', timeoutMs, ...rest } = init;

    let urlStr: string;
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.href;
    else urlStr = input.url;

    let signal = rest.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!signal && timeoutMs != null && timeoutMs > 0) {
        const ac = new AbortController();
        signal = ac.signal;
        timeout = setTimeout(() => ac.abort(), timeoutMs);
    }

    const useProxy = shouldProxyUrl(urlStr, viaProxy);
    const headers = normalizeHeaders(rest.headers);

    try {
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
                    return (await undiciFetch(
                        urlStr,
                        undiciInit
                    )) as unknown as Response;
                } catch (err) {
                    const allowFallback = !/^(0|false|off|no)$/i.test(
                        (
                            process.env.SCRAPE_PROXY_FALLBACK_DIRECT ?? 'true'
                        ).trim()
                    );
                    if (viaProxy === true || !allowFallback) {
                        throw wrapProxyError(err, urlStr);
                    }
                    // auto mode: fall through to a direct attempt below
                }
            }
        }

        return await fetch(urlStr, { ...rest, headers, signal });
    } finally {
        if (timeout) clearTimeout(timeout);
    }
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
