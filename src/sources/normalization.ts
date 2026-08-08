/**
 * SourceNormalizationService — Phase 2.5
 *
 * Centralizes source typing, metadata extraction, deduplication,
 * stable IDs, provenance, and safe proxy-grant creation.
 *
 * It does NOT perform full media downloads for validation; callers can
 * optionally request a light HEAD/range probe per upstream URL (one probe
 * per unique URL per request, with per-host policy).
 */

import crypto from 'node:crypto';
import type { Source, SourceType } from '@omss/framework';
import type { StremioStream } from '../stremio/protocol.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';
import { scrapeFetch } from '../egress/scrapeFetch.js';

export type NormalizedSource = Source & {
    /** Stable opaque id for this source (hash of upstream + headers + provider). */
    id?: string;
    /** Where this source came from (provider + raw index). Kept non-enumerable so signed URLs never leak. */
    provenance?: { providerId: string; rawIndex: number; upstreamUrl: string; headers?: Record<string, string> };
    /** Expiry hint for cache invalidation (providers often give cacheMaxAge). */
    expiresAt?: string;
    /** Confidence / diagnostic info */
    confidence?: 'high' | 'medium' | 'low';
    /** Extracted extra metadata (hdr, codec, size, language) for UI enrichment. */
    extra?: {
        hdr?: boolean;
        codec?: string;
        language?: string;
        sizeBytes?: number;
        bitrateKbps?: number;
    };
};

export interface NormalizeOptions {
    providerId: string;
    providerName: string;
    /** Async proxy-grant function. If omitted, legacy proxy via caller is used. */
    grants?: PlaybackGrantStore;
    publicBase?: string;
    /** Dedup seen set shared across a single request (upstreamUrl+headers -> void). */
    dedupSeen?: Set<string>;
    /** Optional probe validation (HEAD/range) — default false for latency. */
    probe?: boolean;
    /** Abort signal for probes. */
    signal?: AbortSignal;
    /** Response-level cacheMaxAge from Stremio addon (seconds). */
    responseCacheMaxAge?: number;
}

/**
 * Normalize a URL for deduplication: lower host, strip default port,
 * strip fragment, keep path + query (query sorted for stability except for signed URLs).
 * Signed URLs (with token/sig) are deduped strictly by raw string to avoid breaking signatures.
 */
export function normalizeUpstreamUrl(url: string): string {
    try {
        const u = new URL(url);
        // Heuristic: if query looks signed, don't sort — use raw lower host only
        const sensitive = /token|sig(nature)?|expires|auth|key|signature/i.test(u.search);
        if (sensitive) {
            u.hostname = u.hostname.toLowerCase();
            if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
            u.hash = '';
            return u.toString();
        }
        // Normalize host
        u.hostname = u.hostname.toLowerCase();
        if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
        u.hash = '';
        // Sort query params for stable dedup key (providers often shuffle order)
        const entries = [...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        u.search = '';
        for (const [k, v] of entries) u.searchParams.append(k, v);
        return u.toString();
    } catch {
        return url;
    }
}

function inferTypeFromUrl(url: string): SourceType | null {
    const l = url.toLowerCase();
    if (l.includes('.m3u8')) return 'hls';
    if (l.includes('.mpd')) return 'dash';
    if (l.includes('.mp4')) return 'mp4';
    if (l.includes('.mkv')) return 'mkv';
    if (l.includes('.webm')) return 'webm';
    return null;
}

function longText(s: StremioStream): string {
    return [s.name, s.title, s.description].filter(Boolean).join(' ').toLowerCase();
}

/** Enhanced quality extraction including HDR/DV hints. */
export function inferQualityEnhanced(stream: StremioStream): string {
    const text = longText(stream);
    // Look for explicit resolution first
    const p = text.match(/(\d{3,4})\s?p\b/);
    if (p) return `${p[1]}p`;
    if (/\b(4k|uhd|2160)\b/.test(text)) return '2160p';
    if (/\b(1080|fhd)\b/.test(text)) return '1080p';
    if (/\b(720|hd)\b/.test(text)) return '720p';
    if (/\b(480)\b/.test(text)) return '480p';
    const k = text.match(/\b(\d)\s?k\b/);
    if (k) return `${k[1]}K`;
    // Size hint fallback
    if (/\b\d+(\.\d+)?\s?(gb|mb)\b/.test(text)) return '1080p';
    return 'Auto';
}

export function inferHdr(stream: StremioStream): boolean {
    const text = longText(stream);
    return /\b(hdr|hdr10|dolby[\s-]?vision|dv|hlg)\b/i.test(text);
}

export function inferCodec(stream: StremioStream): string | undefined {
    const text = longText(stream);
    if (/\bhevc\b|\bh\.265\b|\bx265\b/.test(text)) return 'hevc';
    if (/\bavc\b|\bh\.264\b|\bx264\b/.test(text)) return 'h264';
    if (/\bav1\b/.test(text)) return 'av1';
    if (/\bvp9\b/.test(text)) return 'vp9';
    return undefined;
}

export function inferSizeBytes(stream: StremioStream): number | undefined {
    const text = longText(stream);
    const m = text.match(/(\d+(?:\.\d+)?)\s?(gb|mb)\b/);
    if (!m) return undefined;
    const val = Number(m[1]);
    if (!Number.isFinite(val)) return undefined;
    const isGb = m[2].toLowerCase() === 'gb';
    return Math.round(val * (isGb ? 1024 * 1024 * 1024 : 1024 * 1024));
}

export function inferLanguage(stream: StremioStream): string | undefined {
    const text = longText(stream);
    // Very simple heuristic: look for [EN], (eng), multi-audio markers
    if (/\b(eng|english)\b/i.test(text)) return 'en';
    if (/\b(spa|spanish|esp)\b/i.test(text)) return 'es';
    if (/\b(fre|french|fr)\b/i.test(text)) return 'fr';
    if (/\b(ger|german|de)\b/i.test(text)) return 'de';
    if (/\b(multi|dual)[\s-]?audio\b/i.test(text)) return 'multi';
    return undefined;
}

function stableId(upstream: string, headers: Record<string, string> | undefined, providerId: string): string {
    const h = crypto.createHash('sha256');
    h.update(providerId);
    h.update('\0');
    h.update(normalizeUpstreamUrl(upstream));
    if (headers) {
        const keys = Object.keys(headers).sort();
        for (const k of keys) {
            h.update('\0');
            h.update(k.toLowerCase());
            h.update(':');
            h.update(headers[k]);
        }
    }
    return h.digest('hex').slice(0, 16);
}

function confidenceFor(stream: StremioStream, type: SourceType | null): 'high' | 'medium' | 'low' {
    if (type && stream.url && inferQualityEnhanced(stream) !== 'Auto') return 'high';
    if (type) return 'medium';
    return 'low';
}

/**
 * Optionally validate a single upstream URL with a bounded HEAD/range probe.
 * Does NOT download the body. Returns true when HEAD succeeds or when probe is disabled.
 * Per-host validation can be skipped via host policy in callers.
 */
export async function probeUpstream(
    url: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 4000;
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
        // Prefer HEAD; fall back to GET with Range: bytes=0-0 when HEAD blocked
        let res = await scrapeFetch(url, { method: 'HEAD', signal, viaProxy: 'auto', timeoutMs } as never);
        if (res.status === 405 || res.status === 501) {
            res = await scrapeFetch(url, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
                signal,
                viaProxy: 'auto',
                timeoutMs
            } as never);
        }
        clearTimeout(timer);
        // 2xx or 206 partial is success; 403/401 may still be playable with proxy headers, so treat as pass
        if (res.ok || res.status === 206 || res.status === 403 || res.status === 401) return true;
        return false;
    } catch {
        return false;
    }
}

export class SourceNormalizationService {
    /**
     * Normalize an array of StremioStreams into OMSS Sources with
     * deduplication, stable ids, provenance, and safe proxy wrapping.
     * Streams with the same normalized upstream URL + headers are collapsed
     * to the first occurrence (priority order preserved).
     */
    async normalize(
        streams: StremioStream[],
        opts: NormalizeOptions
    ): Promise<NormalizedSource[]> {
        const seen = opts.dedupSeen ?? new Set<string>();
        const out: NormalizedSource[] = [];
        const probeCache = new Map<string, Promise<boolean>>();

        for (let idx = 0; idx < streams.length; idx++) {
            const s = streams[idx];
            if (!s.url || !/^https?:\/\//i.test(s.url)) continue;

            const upstream = s.url;
            const headers = s.behaviorHints?.proxyHeaders?.request as Record<string, string> | undefined;

            // Dedup key = normalizedUrl + sorted headers
            const dedupKey = normalizeUpstreamUrl(upstream) + '|' + (headers ? JSON.stringify(Object.keys(headers).sort().map((k) => [k.toLowerCase(), headers[k]])) : '');
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            // Optional probe validation (one probe per unique upstream per request)
            if (opts.probe) {
                const cacheKey = normalizeUpstreamUrl(upstream);
                let probeP = probeCache.get(cacheKey);
                if (!probeP) {
                    probeP = probeUpstream(upstream, { signal: opts.signal });
                    probeCache.set(cacheKey, probeP);
                }
                const ok = await probeP;
                if (!ok) continue;
            }

            const type = inferTypeFromUrl(upstream) ?? inferTypeFromUrl(longText(s)) ?? 'hls';
            // For .m3u8/.mpd keep hls/dash; otherwise map via heuristics
            const finalType: SourceType = (inferTypeFromUrl(upstream) as SourceType) ?? (type as SourceType);

            const quality = inferQualityEnhanced(s);
            const hdr = inferHdr(s);
            const codec = inferCodec(s);
            const sizeBytes = inferSizeBytes(s);
            const language = inferLanguage(s);
            const id = stableId(upstream, headers, opts.providerId);

            // Safe proxy wrapping — never expose raw upstream URLs.
            // When grants are unavailable we skip the source (production always has grants;
            // dev-only raw mode is legacy and must not leak signed URLs).
            let proxied: string;
            if (opts.grants && opts.publicBase) {
                try {
                    const grant = await opts.grants.issue({
                        url: upstream,
                        headers,
                        providerId: opts.providerId
                    });
                    proxied = opts.grants.toProxyUrl(grant, opts.publicBase);
                } catch {
                    continue; // policy rejected
                }
            } else {
                // No grants available — do not expose raw upstream URL.
                // Skip the source; caller may log diagnostics.
                continue;
            }

            const source: NormalizedSource = {
                url: proxied,
                type: finalType,
                quality,
                audioTracks: [{ language: language ?? 'und', label: s.name?.split('\n')[0]?.slice(0, 60) || opts.providerName }],
                provider: { id: opts.providerId, name: opts.providerName },
                id,
                confidence: confidenceFor(s, finalType as SourceType),
                extra: {
                    hdr,
                    codec,
                    language,
                    sizeBytes
                }
            };
            // Keep provenance internal (non-enumerable) — it contains the signed upstreamUrl + headers
            // and must not survive JSON serialization to the public response.
            Object.defineProperty(source, 'provenance', {
                value: { providerId: opts.providerId, rawIndex: idx, upstreamUrl: upstream, headers },
                enumerable: false,
                writable: true,
                configurable: true
            });

            // Expiry: honour cacheMaxAge — prefer per-stream, else response-level (Stremio standard)
            const streamAge = (s as unknown as { cacheMaxAge?: number }).cacheMaxAge;
            const cacheAge = typeof streamAge === 'number' ? streamAge : opts.responseCacheMaxAge;
            if (typeof cacheAge === 'number' && cacheAge > 0) {
                source.expiresAt = new Date(Date.now() + cacheAge * 1000).toISOString();
            }

            out.push(source);
        }

        return out;
    }

    /**
     * Deduplicate an already-materialized Source array by normalized upstream URL + headers.
     * Useful for bulk merge after multiple providers have been normalized separately.
     */
    dedupe(sources: NormalizedSource[]): NormalizedSource[] {
        const seen = new Set<string>();
        const out: NormalizedSource[] = [];
        for (const s of sources) {
            const prov = (s as unknown as { provenance?: { upstreamUrl: string; headers?: Record<string, string> } }).provenance;
            const upstream = prov?.upstreamUrl ?? s.url;
            const headers = prov?.headers;
            const headerKey = headers ? JSON.stringify(Object.entries(headers).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k.toLowerCase()}:${v}`)) : '';
            const key = normalizeUpstreamUrl(upstream) + '|' + headerKey;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
        return out;
    }
}

export const globalSourceNormalization = new SourceNormalizationService();
