/**
 * Real-Debrid resolver.
 *
 * Flow (targets already-cached torrents to keep the waterfall fast):
 *   addMagnet → info(files) → selectFiles(target) → poll until "downloaded"
 *   → unrestrict(link) → direct HTTP url.
 * If the torrent isn't instantly available it is deleted and null is returned.
 *
 * Debrid API calls go DIRECT (never through the residential egress proxy) so we
 * don't trip the account's fraud/geo protection.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
import { buildMagnet, pickFileIndex } from './magnet.js';
import type { DebridResolver, ResolveInput } from './types.js';

const BASE = 'https://api.real-debrid.com/rest/1.0';

interface RdTorrentInfo {
    id: string;
    status: string;
    links: string[];
    files: Array<{ id: number; path: string; bytes: number; selected: number }>;
}

export class RealDebridResolver implements DebridResolver {
    readonly id = 'realdebrid' as const;
    readonly name = 'Real-Debrid';

    constructor(private readonly apiKey: string) {}

    private async rd<T>(
        path: string,
        init: { method?: string; form?: Record<string, string> } = {}
    ): Promise<T> {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json'
        };
        let body: string | undefined;
        if (init.form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams(init.form).toString();
        }
        const res = await scrapeFetch(`${BASE}${path}`, {
            method: init.method ?? (init.form ? 'POST' : 'GET'),
            headers,
            body,
            viaProxy: false,
            timeoutMs: 15_000
        });
        if (!res.ok) {
            throw new Error(`Real-Debrid ${path} → HTTP ${res.status}`);
        }
        // Some endpoints (selectFiles) return 204 with no body.
        if (res.status === 204) return {} as T;
        return (await res.json()) as T;
    }

    async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
        try {
            const user = await this.rd<{ username?: string; type?: string }>(
                '/user'
            );
            return { ok: true, user: user.username };
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'check failed'
            };
        }
    }

    async resolve(input: ResolveInput): Promise<string | null> {
        const magnet = buildMagnet(input.infoHash, input.sources, input.title);
        let torrentId: string | null = null;
        try {
            const added = await this.rd<{ id: string }>('/torrents/addMagnet', {
                form: { magnet }
            });
            torrentId = added.id;

            let info = await this.rd<RdTorrentInfo>(
                `/torrents/info/${torrentId}`
            );

            const files = info.files.map((f) => ({
                name: f.path,
                size: f.bytes
            }));
            const idx = pickFileIndex(files, {
                fileIdx: input.fileIdx,
                season: input.season,
                episode: input.episode
            });
            if (idx < 0) {
                await this.deleteTorrent(torrentId);
                return null;
            }
            const targetRdId = info.files[idx]?.id;

            await this.rd(`/torrents/selectFiles/${torrentId}`, {
                form: { files: String(targetRdId ?? 'all') }
            });

            // Poll briefly: cached torrents flip to "downloaded" almost at once.
            for (let attempt = 0; attempt < 4; attempt++) {
                info = await this.rd<RdTorrentInfo>(
                    `/torrents/info/${torrentId}`
                );
                if (info.status === 'downloaded' && info.links.length) break;
                if (
                    ['magnet_error', 'error', 'virus', 'dead'].includes(
                        info.status
                    )
                ) {
                    await this.deleteTorrent(torrentId);
                    return null;
                }
                await delay(400);
            }

            if (info.status !== 'downloaded' || info.links.length === 0) {
                // Not instantly available — don't make the user wait.
                await this.deleteTorrent(torrentId);
                return null;
            }

            const link = info.links[0];
            const unrestricted = await this.rd<{ download?: string }>(
                '/unrestrict/link',
                { form: { link } }
            );
            return unrestricted.download ?? null;
        } catch {
            if (torrentId) await this.deleteTorrent(torrentId);
            return null;
        }
    }

    private async deleteTorrent(id: string): Promise<void> {
        try {
            await this.rd(`/torrents/delete/${id}`, { method: 'DELETE' });
        } catch {
            /* best-effort cleanup */
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
