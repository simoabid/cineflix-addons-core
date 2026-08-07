/**
 * Central redaction utility for logs, errors, audits, exports, and API responses.
 *
 * Never log or return raw secrets, credentials, or sensitive query values.
 */

const SENSITIVE_QUERY_KEYS = new Set([
    'token',
    'apikey',
    'api_key',
    'api-key',
    'key',
    'auth',
    'authorization',
    'password',
    'passwd',
    'secret',
    'access_token',
    'refresh_token',
    'authkey',
    'auth_key',
    'session',
    'cookie',
    'signature',
    'sig',
    'jwt',
    'bearer',
    'credential',
    'credentials',
    'private',
    'rd',
    'realdebrid',
    'alldebrid',
    'premiumize'
]);

const SENSITIVE_HEADER_KEYS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-admin-token',
    'x-api-key',
    'x-auth-token',
    'x-access-token'
]);

const SECRET_PATTERNS: RegExp[] = [
    // Bearer / Basic auth
    /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    // Common API key shapes in free text
    /\b(api[_-]?key|token|password|secret|authKey)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
    // Long opaque tokens
    /\b[A-Za-z0-9_-]{32,}\b/g
];

export function redactString(value: string, maxLen = 500): string {
    let out = value;
    for (const re of SECRET_PATTERNS) {
        out = out.replace(re, (match) => {
            // Keep short structural tokens (e.g. UUIDs used as ids) if they look like ids
            if (/^[0-9a-f-]{36}$/i.test(match)) return match;
            if (
                match.length < 24 &&
                !/Bearer|Basic|api|token|password|secret/i.test(match)
            ) {
                return match;
            }
            return '[REDACTED]';
        });
    }
    if (out.length > maxLen) out = out.slice(0, maxLen) + '…';
    return out;
}

/** Redact sensitive query/fragment values from a URL string. */
export function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        // Drop userinfo
        u.username = '';
        u.password = '';
        // Rebuild query manually so the REDACTED marker is not percent-encoded
        // into an unreadable form by URLSearchParams.
        const pairs: string[] = [];
        for (const [key, value] of u.searchParams.entries()) {
            if (
                SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ||
                /token|key|secret|auth|pass/i.test(key)
            ) {
                pairs.push(`${encodeURIComponent(key)}=REDACTED`);
            } else {
                pairs.push(
                    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
                );
            }
        }
        u.search = pairs.length ? `?${pairs.join('&')}` : '';
        if (u.hash && /token|key|secret|auth/i.test(u.hash)) {
            u.hash = '#REDACTED';
        }
        return u.toString();
    } catch {
        return redactString(url, 200);
    }
}

/** Redact a header map for logging. */
export function redactHeaders(
    headers?: Record<string, string | string[] | undefined> | Headers | null
): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    const entries: Array<[string, string]> = [];

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((v, k) => entries.push([k, v]));
    } else {
        for (const [k, v] of Object.entries(
            headers as Record<string, string | string[] | undefined>
        )) {
            if (v == null) continue;
            entries.push([k, Array.isArray(v) ? v.join(', ') : v]);
        }
    }

    for (const [k, v] of entries) {
        if (
            SENSITIVE_HEADER_KEYS.has(k.toLowerCase()) ||
            /token|auth|key|secret|cookie/i.test(k)
        ) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = redactString(v, 120);
        }
    }
    return out;
}

/** Deep-ish redact of plain objects for safe audit/log payloads. */
export function redactValue(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[MAX_DEPTH]';
    if (value == null) return value;
    if (typeof value === 'string') {
        if (/^https?:\/\//i.test(value)) return redactUrl(value);
        return redactString(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value))
        return value.map((v) => redactValue(v, depth + 1));
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (
                SENSITIVE_QUERY_KEYS.has(k.toLowerCase()) ||
                SENSITIVE_HEADER_KEYS.has(k.toLowerCase()) ||
                /password|secret|apikey|api_key|token|authkey|authorization|cookie/i.test(
                    k
                )
            ) {
                out[k] = v == null || v === '' ? v : '[REDACTED]';
            } else if (
                k.toLowerCase().includes('url') &&
                typeof v === 'string'
            ) {
                out[k] = redactUrl(v);
            } else {
                out[k] = redactValue(v, depth + 1);
            }
        }
        return out;
    }
    return String(value);
}

/** Mask a secret for UI: show only last 4 chars when long enough. */
export function maskSecret(secret: string | undefined | null): string {
    if (!secret) return '';
    if (secret.length <= 4) return '****';
    if (secret.length <= 8)
        return '*'.repeat(secret.length - 2) + secret.slice(-2);
    return '****…' + secret.slice(-4);
}
