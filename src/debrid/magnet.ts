/**
 * Magnet / infoHash helpers for debrid resolution.
 *
 * Stremio torrent streams carry a 40-hex (or 32 base32) `infoHash` plus optional
 * `sources` (trackers). We reconstruct a magnet URI for debrid providers.
 */
import {
    scoreAndSelectFile,
    isVideoFile,
    isSampleOrBonusFile as isSampleFile
} from './fileSelection.js';

export {
    isVideoFile,
    isSampleFile,
    scoreAndSelectFile
};

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

/**
 * Pick the best file index for a request from a list of files.
 * Uses the explainable multi-factor scoring engine.
 */
export function pickFileIndex(
    files: Array<{ name: string; size: number }>,
    opts: { fileIdx?: number; season?: number; episode?: number } = {}
): number {
    const res = scoreAndSelectFile(files, opts);
    return res.index;
}
