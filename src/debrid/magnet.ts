/**
 * Magnet / infoHash helpers for debrid resolution.
 *
 * Stremio torrent streams carry a 40-hex (or 32 base32) `infoHash` plus optional
 * `sources` (trackers). We reconstruct a magnet URI for debrid providers.
 */

/** Common public trackers appended when an addon gives none. */
const FALLBACK_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce'
];

/** Normalise an infoHash to lowercase hex where possible. */
export function normalizeInfoHash(hash: string): string {
    return hash.trim().toLowerCase();
}

export function isValidInfoHash(hash: string): boolean {
    const h = normalizeInfoHash(hash);
    // 40-char hex (v1) or 32-char base32.
    return /^[a-f0-9]{40}$/.test(h) || /^[a-z2-7]{32}$/i.test(h);
}

/**
 * Build a magnet URI from an infoHash + optional tracker/source list.
 * `sources` follow the Stremio convention: entries like "tracker:udp://..."
 * or "dht:..." — we keep only tracker URLs.
 */
export function buildMagnet(
    infoHash: string,
    sources?: string[],
    displayName?: string
): string {
    const h = normalizeInfoHash(infoHash);
    const params: string[] = [`xt=urn:btih:${h}`];
    if (displayName) params.push(`dn=${encodeURIComponent(displayName)}`);

    const trackers = new Set<string>();
    for (const s of sources ?? []) {
        const t = s.startsWith('tracker:') ? s.slice('tracker:'.length) : s;
        if (/^(udp|https?|wss?):\/\//i.test(t)) trackers.add(t);
    }
    if (trackers.size === 0) {
        FALLBACK_TRACKERS.forEach((t) => trackers.add(t));
    }
    for (const t of trackers) params.push(`tr=${encodeURIComponent(t)}`);

    return `magnet:?${params.join('&')}`;
}

/** Extract the infoHash from a magnet URI (null if not present). */
export function infoHashFromMagnet(magnet: string): string | null {
    const m = magnet.match(/urn:btih:([a-z0-9]+)/i);
    return m ? normalizeInfoHash(m[1]) : null;
}

/** Heuristic: does a filename look like a playable video file? */
export function isVideoFile(name: string): boolean {
    return /\.(mp4|mkv|avi|mov|webm|flv|m4v|ts|m2ts|wmv|mpg|mpeg)$/i.test(name);
}

/** Sample-file guard so we don't pick a 40 MB "sample" over the feature. */
export function isSampleFile(name: string): boolean {
    return /\bsample\b/i.test(name);
}

/**
 * Pick the best file index for a request from a list of files.
 * Prefers an explicit fileIdx, then a season/episode match, then largest video.
 */
export function pickFileIndex(
    files: Array<{ name: string; size: number }>,
    opts: { fileIdx?: number; season?: number; episode?: number } = {}
): number {
    if (files.length === 0) return -1;

    if (
        opts.fileIdx != null &&
        opts.fileIdx >= 0 &&
        opts.fileIdx < files.length
    ) {
        return opts.fileIdx;
    }

    const videoIdx = files
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => isVideoFile(f.name) && !isSampleFile(f.name));
    const pool = videoIdx.length ? videoIdx : files.map((f, i) => ({ f, i }));

    // Season/episode match (e.g. S01E02, 1x02).
    if (opts.season != null && opts.episode != null) {
        const s = String(opts.season).padStart(2, '0');
        const e = String(opts.episode).padStart(2, '0');
        const patterns = [
            new RegExp(`s0*${opts.season}[ ._-]*e0*${opts.episode}\\b`, 'i'),
            new RegExp(`\\b${opts.season}x0*${opts.episode}\\b`, 'i'),
            new RegExp(`\\bS${s}E${e}\\b`, 'i')
        ];
        const match = pool.find(({ f }) =>
            patterns.some((p) => p.test(f.name))
        );
        if (match) return match.i;
    }

    // Otherwise the largest (video) file.
    return pool.reduce((best, cur) => (cur.f.size > best.f.size ? cur : best))
        .i;
}
