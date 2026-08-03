/**
 * Map Stremio addon responses into OMSS shapes.
 *
 * Stremio streams have no strict schema for quality/type/audio, so we infer
 * them from the url + human-readable name/title/description (same heuristics as
 * @omss/framework's built-in StremioService, extended a little).
 */
import type {
    Source,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import type { StremioStream, StremioSubtitle } from './protocol.js';

export type ProxyFn = (url: string, headers?: Record<string, string>) => string;

function longText(stream: StremioStream): string {
    return [stream.name, stream.title, stream.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

/** Map a URL's extension to an OMSS SourceType (null when unknown). */
export function inferTypeFromUrl(url: string): SourceType | null {
    const u = url.toLowerCase();
    if (u.includes('.m3u8')) return 'hls';
    if (u.includes('.mpd')) return 'dash';
    if (u.includes('.mp4')) return 'mp4';
    if (u.includes('.mkv')) return 'mkv';
    if (u.includes('.webm')) return 'webm';
    return null;
}

export function inferSourceType(stream: StremioStream): SourceType {
    const byUrl = inferTypeFromUrl(stream.url ?? '');
    if (byUrl) return byUrl;
    const text = longText(stream);
    // File-based addons usually advertise size (e.g. "1.4 GB") for direct files.
    if (/\b\d+(\.\d+)?\s?(gb|mb)\b/.test(text)) return 'mp4';
    return 'hls';
}

export function inferQuality(stream: StremioStream): string {
    const text = longText(stream);
    const p = text.match(/(\d{3,4})\s?p\b/);
    if (p) return `${p[1]}p`;
    if (/\b(4k|uhd|2160)\b/.test(text)) return '2160p';
    if (/\b(1080|fhd)\b/.test(text)) return '1080p';
    if (/\b(720|hd)\b/.test(text)) return '720p';
    const k = text.match(/\b(\d)\s?k\b/);
    if (k) return `${k[1]}K`;
    return 'Auto';
}

/**
 * A Stremio stream is natively web-playable only when it carries a direct
 * http(s) media url. Torrents (`infoHash`), YouTube (`ytId`) and external
 * players (`externalUrl` only) are excluded from MVP source output.
 */
export function isPlayableStream(stream: StremioStream): boolean {
    if (!stream.url) return false;
    return /^https?:\/\//i.test(stream.url);
}

/** Human label for a stream, kept short for the source picker. */
function streamLabel(stream: StremioStream, fallback: string): string {
    const raw = (stream.name || stream.title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return fallback;
    // Collapse multi-line addon names to their first line.
    return raw.split('\n')[0].slice(0, 60);
}

export function mapStreamsToSources(
    streams: StremioStream[],
    providerId: string,
    providerName: string,
    proxy: ProxyFn
): Source[] {
    const sources: Source[] = [];
    for (const stream of streams) {
        if (!isPlayableStream(stream)) continue;
        const upstream = stream.url as string;
        const reqHeaders = stream.behaviorHints?.proxyHeaders?.request;
        const proxied = reqHeaders
            ? proxy(upstream, reqHeaders)
            : proxy(upstream);
        const label = streamLabel(stream, providerName);
        sources.push({
            url: proxied,
            type: inferSourceType(stream),
            quality: inferQuality(stream),
            audioTracks: [{ language: 'und', label }],
            provider: { id: providerId, name: providerName }
        });
    }
    return sources;
}

export function inferSubtitleFormat(url: string, fmt?: string): SubtitleFormat {
    const f = (fmt ?? '').toLowerCase();
    if (f === 'srt' || f === 'vtt' || f === 'ass' || f === 'ssa') return f;
    if (f === 'ttml') return 'ttml';
    const u = url.toLowerCase();
    if (u.includes('.srt')) return 'srt';
    if (u.includes('.ass')) return 'ass';
    if (u.includes('.ssa')) return 'ssa';
    if (u.includes('.ttml') || u.includes('.xml')) return 'ttml';
    return 'vtt';
}

export function mapSubtitles(
    subs: StremioSubtitle[],
    proxy: ProxyFn
): Subtitle[] {
    const out: Subtitle[] = [];
    const seen = new Set<string>();
    for (const s of subs) {
        if (!s?.url || !/^https?:\/\//i.test(s.url)) continue;
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        out.push({
            url: proxy(s.url),
            label: s.lang || s.id || 'Unknown',
            format: inferSubtitleFormat(s.url, s.format)
        });
    }
    return out;
}
