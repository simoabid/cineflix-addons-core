/**
 * Policy-aware outbound fetch used by imports, manifests, and other
 * untrusted remote fetches. Applies URL/DNS SSRF checks, redirect
 * revalidation, size caps, timeouts, and content-type awareness.
 *
 * Does not replace scrapeFetch for high-volume addon stream scrapes yet;
 * those gain SSRF protection through validateOutboundUrl at call sites and
 * the secure proxy path for browser-facing egress.
 */

import { scrapeFetch, type ScrapeFetchInit } from '../egress/scrapeFetch.js';
import {
    UrlPolicyError,
    validateOutboundUrl,
    type UrlPolicyOptions,
    type ValidatedUrl
} from './urlPolicy.js';
import { redactUrl } from './redaction.js';

export interface SecureFetchLimits {
    /** Overall wall-clock budget for the whole redirect chain. */
    timeoutMs?: number;
    /** Max redirects to follow (each revalidated). Default 3. */
    maxRedirects?: number;
    /** Max response body bytes (compressed on the wire). Default 2 MiB. */
    maxBytes?: number;
    /** Optional content-type allowlist substrings (e.g. ['json', 'text/plain']). */
    acceptContentTypes?: string[];
}

export interface SecureFetchResult {
    response: Response;
    finalUrl: string;
    validated: ValidatedUrl;
    bytesRead: number;
    text?: string;
}

export class SecureFetchError extends Error {
    readonly code: string;
    readonly status?: number;

    constructor(code: string, message: string, status?: number) {
        super(message);
        this.name = 'SecureFetchError';
        this.code = code;
        this.status = status;
    }
}

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length'
]);

/** Strip hop-by-hop and client-auth headers before forwarding upstream. */
export function sanitizeOutboundHeaders(
    headers?: Record<string, string>
): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        if (lower === 'cookie' || lower === 'authorization') continue;
        if (lower.startsWith('x-forwarded-') || lower === 'forwarded') continue;
        out[k] = v;
    }
    return out;
}

export async function secureFetch(
    rawUrl: string,
    init: ScrapeFetchInit &
        SecureFetchLimits & { policy?: UrlPolicyOptions } = {}
): Promise<SecureFetchResult> {
    const {
        timeoutMs = 15_000,
        maxRedirects = 3,
        maxBytes = 2 * 1024 * 1024,
        acceptContentTypes,
        policy = {},
        ...fetchInit
    } = init;

    const deadline = Date.now() + timeoutMs;
    let current = rawUrl;
    let redirects = 0;
    let validated: ValidatedUrl | null = null;

    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new SecureFetchError(
                'TIMEOUT',
                `Request timed out for ${redactUrl(rawUrl)}`
            );
        }

        validated = await validateOutboundUrl(current, policy);
        const headers = sanitizeOutboundHeaders(
            (fetchInit.headers as Record<string, string> | undefined) ??
                undefined
        );

        // Manual redirect handling so every hop is revalidated.
        // Pin to validated address to resist DNS rebinding.
        const pinnedIp = validated.pinnedAddress;
        const usePinned = Boolean(pinnedIp && pinnedIp !== validated.hostname);
        const res = await scrapeFetch(validated.url.toString(), {
            ...fetchInit,
            headers,
            redirect: 'manual',
            timeoutMs: remaining,
            // Imports of arbitrary hosts still benefit from egress proxy.
            viaProxy: fetchInit.viaProxy ?? 'auto',
            ...(usePinned ? { pinnedIp } : {})
        });

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) {
                throw new SecureFetchError(
                    'BAD_REDIRECT',
                    `Redirect without Location from ${redactUrl(current)}`,
                    res.status
                );
            }
            redirects += 1;
            if (redirects > maxRedirects) {
                throw new SecureFetchError(
                    'TOO_MANY_REDIRECTS',
                    `Exceeded ${maxRedirects} redirects starting from ${redactUrl(rawUrl)}`
                );
            }
            // Resolve relative Location against the current URL.
            current = new URL(location, validated.url).toString();
            continue;
        }

        if (acceptContentTypes && acceptContentTypes.length > 0) {
            const ct = (res.headers.get('content-type') ?? '').toLowerCase();
            const ok = acceptContentTypes.some((a) =>
                ct.includes(a.toLowerCase())
            );
            if (!ok && res.ok) {
                throw new SecureFetchError(
                    'BAD_CONTENT_TYPE',
                    `Unexpected content-type '${ct || 'unknown'}' from ${redactUrl(current)}`,
                    res.status
                );
            }
        }

        // Enforce body size while reading.
        const lenHeader = res.headers.get('content-length');
        if (lenHeader) {
            const declared = Number(lenHeader);
            if (Number.isFinite(declared) && declared > maxBytes) {
                throw new SecureFetchError(
                    'BODY_TOO_LARGE',
                    `Response Content-Length ${declared} exceeds limit ${maxBytes}`,
                    res.status
                );
            }
        }

        const buf = await readBodyLimited(res, maxBytes);
        // Reconstruct a Response so callers can still use .json()/.text().
        const rebuilt = new Response(buf, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
        });

        return {
            response: rebuilt,
            finalUrl: current,
            validated,
            bytesRead: buf.byteLength,
            text: undefined
        };
    }
}

async function readBodyLimited(
    res: Response,
    maxBytes: number
): Promise<ArrayBuffer> {
    // Prefer arrayBuffer with a size guard via streaming when available.
    if (!res.body) return new ArrayBuffer(0);

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    /* ignore */
                }
                throw new SecureFetchError(
                    'BODY_TOO_LARGE',
                    `Response body exceeded ${maxBytes} bytes`
                );
            }
            chunks.push(value);
        }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out.buffer;
}

/** Convenience: secure GET + parse JSON with size/type caps. */
export async function secureFetchJson<T = unknown>(
    rawUrl: string,
    init: ScrapeFetchInit &
        SecureFetchLimits & { policy?: UrlPolicyOptions } = {}
): Promise<{ data: T; finalUrl: string; bytesRead: number }> {
    const result = await secureFetch(rawUrl, {
        ...init,
        headers: {
            Accept: 'application/json',
            ...(init.headers as Record<string, string> | undefined)
        },
        acceptContentTypes: init.acceptContentTypes ?? [
            'json',
            'text/plain',
            'javascript'
        ]
    });
    if (!result.response.ok) {
        throw new SecureFetchError(
            'HTTP_ERROR',
            `HTTP ${result.response.status} for ${redactUrl(result.finalUrl)}`,
            result.response.status
        );
    }
    let data: T;
    try {
        data = (await result.response.json()) as T;
    } catch {
        throw new SecureFetchError(
            'BAD_JSON',
            `Response from ${redactUrl(result.finalUrl)} is not valid JSON`
        );
    }
    return { data, finalUrl: result.finalUrl, bytesRead: result.bytesRead };
}

export function isPolicyOrSecureError(
    err: unknown
): err is UrlPolicyError | SecureFetchError {
    return err instanceof UrlPolicyError || err instanceof SecureFetchError;
}
