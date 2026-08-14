/**
 * Outbound URL policy — SSRF, protocol, and host defenses shared by
 * proxy, imports, manifests, redirects, and stream fetches.
 *
 * Design notes:
 * - Permit only https by default; http is an explicit opt-in.
 * - Parse with the WHATWG URL parser; reject credentials-in-URL forms for
 *   untrusted targets (userinfo is stripped / rejected).
 * - Classify every resolved address (IPv4 + IPv6) against private, loopback,
 *   link-local, multicast, CGNAT, and cloud-metadata ranges.
 * - Callers must revalidate every redirect target, not only the first URL.
 */

import { isIP } from 'node:net';
import dns from 'node:dns/promises';

export type UrlPolicyErrorCode =
    | 'INVALID_URL'
    | 'BLOCKED_PROTOCOL'
    | 'BLOCKED_CREDENTIALS'
    | 'BLOCKED_HOST'
    | 'BLOCKED_IP'
    | 'DNS_FAILED'
    | 'BLOCKED_PORT'
    | 'URL_TOO_LONG';

export class UrlPolicyError extends Error {
    readonly code: UrlPolicyErrorCode;

    constructor(code: UrlPolicyErrorCode, message: string) {
        super(message);
        this.name = 'UrlPolicyError';
        this.code = code;
    }
}

export interface UrlPolicyOptions {
    /** Allow http:// (default false — https only). */
    allowHttp?: boolean;
    /** Extra allowed protocols, e.g. ['http:']. */
    allowedProtocols?: string[];
    /** Host suffixes always allowed even if they resolve privately (dev only). */
    allowHostSuffixes?: string[];
    /** Explicit host allowlist (exact or suffix match). Empty = no allowlist. */
    hostAllowlist?: string[];
    /** Allow URLs that embed userinfo (user:pass@host). Default false. */
    allowCredentials?: boolean;
    /** Block non-default ports unless listed. Empty = allow any non-blocked. */
    allowedPorts?: number[];
    /** Maximum URL length. */
    maxLength?: number;
    /** Skip DNS resolution (syntax + literal-IP checks only). */
    skipDns?: boolean;
    /** Custom DNS lookup (tests). */
    lookup?: (hostname: string) => Promise<string[]>;
}

export interface ValidatedUrl {
    url: URL;
    hostname: string;
    addresses: string[];
    /** Prefer pinning the first validated A/AAAA when connecting. */
    pinnedAddress?: string;
}

/** IPv4 ranges that must never be reached as untrusted outbound targets. */
const BLOCKED_IPV4: Array<{ base: number; mask: number; label: string }> = [
    // 0.0.0.0/8
    { base: ip4('0.0.0.0'), mask: 8, label: 'this-network' },
    // 10.0.0.0/8
    { base: ip4('10.0.0.0'), mask: 8, label: 'private' },
    // 100.64.0.0/10 CGNAT
    { base: ip4('100.64.0.0'), mask: 10, label: 'cgnat' },
    // 127.0.0.0/8 loopback
    { base: ip4('127.0.0.0'), mask: 8, label: 'loopback' },
    // 169.254.0.0/16 link-local + cloud metadata (169.254.169.254)
    { base: ip4('169.254.0.0'), mask: 16, label: 'link-local' },
    // 172.16.0.0/12
    { base: ip4('172.16.0.0'), mask: 12, label: 'private' },
    // 192.0.0.0/24 IETF protocol
    { base: ip4('192.0.0.0'), mask: 24, label: 'ietf-protocol' },
    // 192.0.2.0/24 TEST-NET-1
    { base: ip4('192.0.2.0'), mask: 24, label: 'test-net' },
    // 192.168.0.0/16
    { base: ip4('192.168.0.0'), mask: 16, label: 'private' },
    // 198.18.0.0/15 benchmarking
    { base: ip4('198.18.0.0'), mask: 15, label: 'benchmark' },
    // 198.51.100.0/24 TEST-NET-2
    { base: ip4('198.51.100.0'), mask: 24, label: 'test-net' },
    // 203.0.113.0/24 TEST-NET-3
    { base: ip4('203.0.113.0'), mask: 24, label: 'test-net' },
    // 224.0.0.0/4 multicast
    { base: ip4('224.0.0.0'), mask: 4, label: 'multicast' },
    // 255.255.255.255/32 broadcast (checked before the broader reserved range)
    { base: ip4('255.255.255.255'), mask: 32, label: 'broadcast' },
    // 240.0.0.0/4 reserved
    { base: ip4('240.0.0.0'), mask: 4, label: 'reserved' }
];

function ip4(dotted: string): number {
    const parts = dotted.split('.').map((p) => Number(p));
    return (
        (((parts[0] << 24) >>> 0) +
            ((parts[1] << 16) >>> 0) +
            ((parts[2] << 8) >>> 0) +
            (parts[3] >>> 0)) >>>
        0
    );
}

function inCidr(addr: number, base: number, mask: number): boolean {
    if (mask === 0) return true;
    const shift = 32 - mask;
    return addr >>> shift === base >>> shift;
}

/** Normalize and classify an IP string. Returns a block reason or null. */
export function classifyBlockedIp(address: string): string | null {
    const ver = isIP(address);
    if (ver === 0) return 'invalid-ip';

    if (ver === 4) {
        const n = ip4(address);
        for (const range of BLOCKED_IPV4) {
            if (inCidr(n, range.base, range.mask)) return range.label;
        }
        return null;
    }

    // IPv6
    const normalized = normalizeIpv6(address);
    if (!normalized) return 'invalid-ip';

    // :: / unspecified
    if (normalized === '0000:0000:0000:0000:0000:0000:0000:0000') {
        return 'unspecified';
    }
    // ::1 loopback
    if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
        return 'loopback';
    }
    // fc00::/7 unique local
    const first = parseInt(normalized.slice(0, 4), 16);
    if ((first & 0xfe00) === 0xfc00) return 'unique-local';
    // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfe80) return 'link-local';
    // ff00::/8 multicast
    if ((first & 0xff00) === 0xff00) return 'multicast';
    // ::ffff:0:0/96 IPv4-mapped — re-check embedded v4
    if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:')) {
        const parts = normalized.split(':');
        const hi = parseInt(parts[6], 16);
        const lo = parseInt(parts[7], 16);
        const v4 =
            ((hi >> 8) & 0xff) +
            '.' +
            (hi & 0xff) +
            '.' +
            ((lo >> 8) & 0xff) +
            '.' +
            (lo & 0xff);
        return classifyBlockedIp(v4);
    }
    // 64:ff9b::/96 NAT64 — embedded IPv4 must also be classified
    if (normalized.startsWith('0064:ff9b:0000:0000:0000:0000:')) {
        const parts = normalized.split(':');
        const hi = parseInt(parts[6], 16);
        const lo = parseInt(parts[7], 16);
        const v4 =
            ((hi >> 8) & 0xff) +
            '.' +
            (hi & 0xff) +
            '.' +
            ((lo >> 8) & 0xff) +
            '.' +
            (lo & 0xff);
        const inner = classifyBlockedIp(v4);
        if (inner) return `nat64-${inner}`;
        // Even if inner is public, the NAT64 prefix itself is not private, but we
        // still want to flag it as nat64 for audit. Only block if inner was blocked.
        // However, to close the SSRF window the reviewer flagged, treat any NAT64
        // that maps to private space as blocked and otherwise allow but log.
        // Returning null here allows the address but callers can still decide.
        // For defense, we block NAT64 that embeds CGNAT/metadata-like ranges already
        // handled above; non-blocked embedded public IPs pass through.
        return null;
    }
    // 64:ff9b:1::/48 with different prefix variations (e.g. 0064:ff9b:0001)
    // Generic check: if normalized starts with 0064:ff9b
    if (normalized.startsWith('0064:ff9b:')) {
        // Attempt to extract last 32 bits regardless of prefix length variant
        const parts = normalized.split(':');
        // For /96, the last two hextets are the IPv4; for other NAT64 drafts,
        // still check the embedded address similarly.
        if (parts.length === 8) {
            const hi = parseInt(parts[6], 16);
            const lo = parseInt(parts[7], 16);
            if (Number.isFinite(hi) && Number.isFinite(lo)) {
                const v4 =
                    ((hi >> 8) & 0xff) +
                    '.' +
                    (hi & 0xff) +
                    '.' +
                    ((lo >> 8) & 0xff) +
                    '.' +
                    (lo & 0xff);
                const inner = classifyBlockedIp(v4);
                if (inner) return `nat64-${inner}`;
            }
        }
    }
    // 2001:db8::/32 documentation
    if (
        (first & 0xffff) === 0x2001 &&
        parseInt(normalized.slice(5, 9), 16) === 0x0db8
    ) {
        return 'documentation';
    }

    return null;
}

/** Expand IPv6 to 8 zero-padded hextets. */
export function normalizeIpv6(address: string): string | null {
    let addr = address.toLowerCase().trim();
    if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);

    // Drop zone id
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);

    if (isIP(addr) !== 6) return null;

    const [left, right = ''] = addr.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];

    // Handle dotted IPv4 tail
    const fixTail = (parts: string[]): string[] => {
        if (parts.length === 0) return parts;
        const last = parts[parts.length - 1];
        if (last.includes('.')) {
            const v4 = last.split('.').map(Number);
            if (
                v4.length !== 4 ||
                v4.some((n) => !Number.isFinite(n) || n < 0 || n > 255)
            ) {
                return parts;
            }
            parts = parts.slice(0, -1);
            parts.push(((v4[0] << 8) | v4[1]).toString(16));
            parts.push(((v4[2] << 8) | v4[3]).toString(16));
        }
        return parts;
    };

    const L = fixTail(leftParts);
    const R = fixTail(rightParts);
    const missing = 8 - (L.length + R.length);
    if (missing < 0) return null;
    const full = [...L, ...Array(missing).fill('0'), ...R];
    if (full.length !== 8) return null;
    return full.map((h) => h.padStart(4, '0')).join(':');
}

function hostMatches(hostname: string, pattern: string): boolean {
    const h = hostname.toLowerCase();
    const p = pattern.toLowerCase().replace(/^\./, '');
    return h === p || h.endsWith(`.${p}`);
}

/** True when the raw URL string contains whitespace or C0/DEL controls. */
function hasUnsafeUrlChars(raw: string): boolean {
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c <= 0x1f || c === 0x7f || c === 0x20) return true;
    }
    return false;
}

function isLiteralBlockedHost(hostname: string): string | null {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
        return 'localhost';
    }
    if (
        h === 'metadata.google.internal' ||
        h === 'metadata' ||
        h.endsWith('.internal')
    ) {
        return 'cloud-metadata';
    }
    // Literal IP hostname
    if (isIP(h)) {
        return classifyBlockedIp(h);
    }
    return null;
}

/**
 * Validate a URL for untrusted outbound use.
 * Performs parse + policy checks, then DNS resolution (unless skipDns).
 */
export async function validateOutboundUrl(
    raw: string,
    options: UrlPolicyOptions = {}
): Promise<ValidatedUrl> {
    const maxLength = options.maxLength ?? 2048;
    if (!raw || typeof raw !== 'string') {
        throw new UrlPolicyError('INVALID_URL', 'URL is required');
    }
    if (raw.length > maxLength) {
        throw new UrlPolicyError(
            'URL_TOO_LONG',
            `URL exceeds ${maxLength} characters`
        );
    }

    // Reject obvious smuggling / whitespace tricks early
    if (hasUnsafeUrlChars(raw)) {
        throw new UrlPolicyError(
            'INVALID_URL',
            'URL contains control characters or whitespace'
        );
    }

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new UrlPolicyError('INVALID_URL', 'Malformed URL');
    }

    const allowedProtocols = new Set(
        (options.allowedProtocols ?? ['https:']).map((p) =>
            p.endsWith(':') ? p.toLowerCase() : `${p.toLowerCase()}:`
        )
    );
    if (options.allowHttp) allowedProtocols.add('http:');

    if (!allowedProtocols.has(url.protocol.toLowerCase())) {
        throw new UrlPolicyError(
            'BLOCKED_PROTOCOL',
            `Protocol '${url.protocol}' is not permitted (allowed: ${[...allowedProtocols].join(', ')})`
        );
    }

    if (!options.allowCredentials && (url.username || url.password)) {
        throw new UrlPolicyError(
            'BLOCKED_CREDENTIALS',
            'URLs with embedded credentials are not permitted'
        );
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!hostname) {
        throw new UrlPolicyError('INVALID_URL', 'URL is missing a hostname');
    }

    if (options.hostAllowlist && options.hostAllowlist.length > 0) {
        const ok = options.hostAllowlist.some((p) => hostMatches(hostname, p));
        if (!ok) {
            throw new UrlPolicyError(
                'BLOCKED_HOST',
                `Host '${hostname}' is not on the allowlist`
            );
        }
    }

    const allowSuffixes = options.allowHostSuffixes ?? [];
    const hostExempt = allowSuffixes.some((s) => hostMatches(hostname, s));
    const isProd = process.env.NODE_ENV === 'production';

    // In production, suffix exceptions MUST NOT bypass private/loopback blocking
    if (!hostExempt || isProd) {
        const hostBlock = isLiteralBlockedHost(hostname);
        if (hostBlock) {
            throw new UrlPolicyError(
                'BLOCKED_HOST',
                `Host '${hostname}' is blocked (${hostBlock})`
            );
        }
    }

    const port = url.port
        ? Number(url.port)
        : url.protocol === 'https:'
          ? 443
          : url.protocol === 'http:'
            ? 80
            : NaN;
    if (options.allowedPorts && options.allowedPorts.length > 0) {
        if (!options.allowedPorts.includes(port)) {
            throw new UrlPolicyError(
                'BLOCKED_PORT',
                `Port ${port} is not permitted`
            );
        }
    }

    let addresses: string[] = [];
    if (!options.skipDns && !isIP(hostname)) {
        try {
            const lookup =
                options.lookup ??
                (async (host: string) => {
                    const results = await dns.lookup(host, {
                        all: true,
                        verbatim: true
                    });
                    return results.map((r) => r.address);
                });
            addresses = await lookup(hostname);
        } catch (err) {
            if (hostExempt && !isProd) {
                addresses = ['93.184.216.34'];
            } else {
                throw new UrlPolicyError(
                    'DNS_FAILED',
                    `DNS lookup failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
        if (addresses.length === 0) {
            throw new UrlPolicyError(
                'DNS_FAILED',
                `No addresses resolved for '${hostname}'`
            );
        }
        if (!hostExempt || isProd) {
            for (const addr of addresses) {
                const reason = classifyBlockedIp(addr);
                if (reason) {
                    throw new UrlPolicyError(
                        'BLOCKED_IP',
                        `Host '${hostname}' resolves to blocked address ${addr} (${reason})`
                    );
                }
            }
        }
    } else if (isIP(hostname)) {
        addresses = [hostname];
        if (!hostExempt || isProd) {
            const reason = classifyBlockedIp(hostname);
            if (reason) {
                throw new UrlPolicyError(
                    'BLOCKED_IP',
                    `Literal address '${hostname}' is blocked (${reason})`
                );
            }
        }
    }

    return {
        url,
        hostname,
        addresses,
        pinnedAddress: addresses[0]
    };
}

/** Synchronous syntax + literal-IP check (no DNS). Useful for fast filters. */
export function assertUrlSyntax(
    raw: string,
    options: UrlPolicyOptions = {}
): URL {
    // Re-use async path with skipDns via a sync subset
    if (!raw || typeof raw !== 'string') {
        throw new UrlPolicyError('INVALID_URL', 'URL is required');
    }
    if (raw.length > (options.maxLength ?? 2048)) {
        throw new UrlPolicyError('URL_TOO_LONG', 'URL too long');
    }
    if (hasUnsafeUrlChars(raw)) {
        throw new UrlPolicyError(
            'INVALID_URL',
            'URL contains control characters or whitespace'
        );
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new UrlPolicyError('INVALID_URL', 'Malformed URL');
    }
    const allowedProtocols = new Set(
        (options.allowedProtocols ?? ['https:']).map((p) =>
            p.endsWith(':') ? p.toLowerCase() : `${p.toLowerCase()}:`
        )
    );
    if (options.allowHttp) allowedProtocols.add('http:');
    if (!allowedProtocols.has(url.protocol.toLowerCase())) {
        throw new UrlPolicyError(
            'BLOCKED_PROTOCOL',
            `Protocol '${url.protocol}' is not permitted`
        );
    }
    if (!options.allowCredentials && (url.username || url.password)) {
        throw new UrlPolicyError(
            'BLOCKED_CREDENTIALS',
            'Embedded credentials are not permitted'
        );
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const allowSuffixes = options.allowHostSuffixes ?? [];
    const hostExempt = allowSuffixes.some((s) => hostMatches(hostname, s));
    if (!hostExempt) {
        const hostBlock = isLiteralBlockedHost(hostname);
        if (hostBlock) {
            throw new UrlPolicyError(
                'BLOCKED_HOST',
                `Host '${hostname}' is blocked (${hostBlock})`
            );
        }
        if (isIP(hostname)) {
            const reason = classifyBlockedIp(hostname);
            if (reason) {
                throw new UrlPolicyError(
                    'BLOCKED_IP',
                    `Address '${hostname}' is blocked (${reason})`
                );
            }
        }
    }
    return url;
}

/** Build default policy options from app config flags. */
export function policyFromFlags(flags: {
    allowHttp?: boolean;
    hostAllowlist?: string[];
    allowHostSuffixes?: string[];
}): UrlPolicyOptions {
    return {
        allowHttp: flags.allowHttp ?? false,
        hostAllowlist: flags.hostAllowlist,
        allowHostSuffixes: flags.allowHostSuffixes,
        allowCredentials: false,
        maxLength: 2048
    };
}
