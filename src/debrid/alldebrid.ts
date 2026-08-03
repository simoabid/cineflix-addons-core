/**
 * AllDebrid resolver (API v4).
 *
 * Flow: upload magnet → (if ready/cached) status(links) → pick file → unlock.
 * Uncached magnets return null so the waterfall stays fast.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
import { buildMagnet, pickFileIndex } from './magnet.js';
import type { DebridResolver, ResolveInput } from './types.js';

const BASE = 'https://api.alldebrid.com/v4';
const AGENT = 'addons-core';

interface AdEnvelope<T> {
    status: 'success' | 'error';
    data?: T;
    error?: { code?: string; message?: string };
}

export class AllDebridResolver implements DebridResolver {
    readonly id = 'alldebrid' as const;
    readonly name = 'AllDebrid';

    constructor(private readonly apiKey: string) {}

    private async ad<T>(
        path: string,
        params: Record<string, string> = {}
    ): Promise<T> {
        const qs = new URLSearchParams({
            agent: AGENT,
            apikey: this.apiKey,
            ...params
        });
        const res = await scrapeFetch(`${BASE}${path}?${qs.toString()}`, {
            headers: { Accept: 'application/json' },
            viaProxy: false,
            timeoutMs: 15_000
        });
        if (!res.ok) throw new Error(`AllDebrid ${path} → HTTP ${res.status}`);
        const body = (await res.json()) as AdEnvelope<T>;
        if (body.status !== 'success' || !body.data) {
            throw new Error(
                body.error?.message || `AllDebrid ${path} error`
            );
        }
        return body.data;
    }

    async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
        try {
            const data = await this.ad<{ user?: { username?: string } }>(
                '/user'
            );
            return { ok: true, user: data.user?.username };
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'check failed'
            };
        }
    }

    async resolve(input: ResolveInput): Promise<string | null> {
        const magnet = buildMagnet(input.infoHash, input.sources, input.title);
        try {
            const uploaded = await this.ad<{
                magnets: Array<{ id: number; ready?: boolean; hash?: string }>;
            }>('/magnet/upload', { 'magnets[]': magnet });
            const m = uploaded.magnets?.[0];
            if (!m) return null;
            if (m.ready === false) return null; // not cached

            const status = await this.ad<{
                magnets: {
                    links?: Array<{ link: string; filename: string; size: number }>;
                };
            }>('/magnet/status', { id: String(m.id) });

            const links = status.magnets?.links ?? [];
            if (links.length === 0) return null;

            const files = links.map((l) => ({
                name: l.filename,
                size: l.size
            }));
            const idx = pickFileIndex(files, {
                fileIdx: input.fileIdx,
                season: input.season,
                episode: input.episode
            });
            if (idx < 0) return null;

            const unlocked = await this.ad<{ link?: string }>('/link/unlock', {
                link: links[idx].link
            });
            return unlocked.link ?? null;
        } catch {
            return null;
        }
    }
}
