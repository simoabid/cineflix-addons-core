/**
 * Premiumize resolver.
 *
 * `transfer/directdl` returns direct links immediately for cached content;
 * uncached magnets yield an error/empty content → null.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
import { buildMagnet, pickFileIndex } from './magnet.js';
import type { DebridResolver, ResolveInput } from './types.js';

const BASE = 'https://www.premiumize.me/api';

export class PremiumizeResolver implements DebridResolver {
    readonly id = 'premiumize' as const;
    readonly name = 'Premiumize';

    constructor(private readonly apiKey: string) {}

    async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
        try {
            const res = await scrapeFetch(
                `${BASE}/account/info?apikey=${encodeURIComponent(this.apiKey)}`,
                {
                    headers: { Accept: 'application/json' },
                    viaProxy: false,
                    timeoutMs: 15_000
                }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
                status?: string;
                customer_id?: string;
            };
            if (data.status !== 'success') throw new Error('invalid api key');
            return { ok: true, user: data.customer_id };
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
            const body = new URLSearchParams({ src: magnet }).toString();
            const res = await scrapeFetch(
                `${BASE}/transfer/directdl?apikey=${encodeURIComponent(this.apiKey)}`,
                {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body,
                    viaProxy: false,
                    timeoutMs: 20_000
                }
            );
            if (!res.ok) return null;
            const data = (await res.json()) as {
                status?: string;
                content?: Array<{
                    path: string;
                    size: number;
                    link?: string;
                    stream_link?: string;
                }>;
            };
            if (data.status !== 'success' || !data.content?.length) return null;

            const files = data.content.map((c) => ({
                name: c.path,
                size: Number(c.size) || 0
            }));
            const idx = pickFileIndex(files, {
                fileIdx: input.fileIdx,
                season: input.season,
                episode: input.episode
            });
            if (idx < 0) return null;
            const chosen = data.content[idx];
            return chosen.stream_link || chosen.link || null;
        } catch {
            return null;
        }
    }
}
