/**
 * Real-Debrid resolver.
 *
 * Flow (targets already-cached torrents to keep the waterfall fast):
 *   addMagnet → info(files) → selectFiles(target) → poll until "downloaded"
 *   → unrestrict(link) → direct HTTP url.
 * If the torrent isn't instantly available it is cleaned up and marked uncached.
 *
 * Debrid API calls go DIRECT (never through the residential egress proxy) so we
 * don't trip the account's fraud/geo protection.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
import { buildMagnet, isValidInfoHash } from './magnet.js';
import { scoreAndSelectFile } from './fileSelection.js';
import type {
    DebridResolver,
    DebridCapabilities,
    DebridCheckResult,
    DebridResolution,
    DebridErrorKind,
    ResolveInput
} from './types.js';

const BASE = 'https://api.real-debrid.com/rest/1.0';

function isRetryableErrorKind(kind: DebridErrorKind): boolean {
    return (
        kind === 'rate_limited' ||
        kind === 'network_error' ||
        kind === 'provider_down'
    );
}

interface RdTorrentInfo {
    id: string;
    status: string;
    progress?: number;
    links: string[];
    files: Array<{ id: number; path: string; bytes: number; selected: number }>;
}

interface RdUser {
    id?: number;
    username?: string;
    email?: string;
    points?: number;
    type?: 'premium' | 'free';
    premium?: number; // seconds left
    expiration?: string; // ISO date
}

export class RealDebridResolver implements DebridResolver {
    readonly id = 'realdebrid' as const;
    readonly name = 'Real-Debrid';

    constructor(private readonly apiKey: string) {}

    getCapabilities(): DebridCapabilities {
        return {
            supportsInstantAvailabilityCheck: true,
            supportsFileSelection: true,
            supportsUncachedTransfers: true,
            supportsLinkExpiry: false
        };
    }

    classifyError(err: unknown): DebridErrorKind {
        const msg = (
            err instanceof Error ? err.message : String(err)
        ).toLowerCase();
        if (
            msg.includes('401') ||
            msg.includes('403') ||
            msg.includes('bad_token') ||
            msg.includes('token_invalid')
        ) {
            return 'auth_failure';
        }
        if (msg.includes('429') || msg.includes('rate_limit')) {
            return 'rate_limited';
        }
        if (
            msg.includes('infohash') ||
            msg.includes('magnet_error') ||
            msg.includes('invalid')
        ) {
            return 'invalid_torrent';
        }
        if (
            msg.includes('500') ||
            msg.includes('502') ||
            msg.includes('503') ||
            msg.includes('504') ||
            msg.includes('maintenance')
        ) {
            return 'provider_down';
        }
        if (
            msg.includes('timeout') ||
            msg.includes('timedout') ||
            msg.includes('etimedout') ||
            msg.includes('econnreset') ||
            msg.includes('econnrefused') ||
            msg.includes('enetunreach') ||
            msg.includes('enotfound')
        ) {
            return 'network_error';
        }
        return 'unknown';
    }

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

    async checkCredentials(): Promise<DebridCheckResult> {
        try {
            const user = await this.rd<RdUser>('/user');
            const expiresAt = user.expiration
                ? new Date(user.expiration)
                : undefined;
            const premiumDaysRemaining = user.premium
                ? Math.floor(user.premium / 86400)
                : expiresAt
                  ? Math.max(
                        0,
                        Math.floor(
                            (expiresAt.getTime() - Date.now()) / (86400 * 1000)
                        )
                    )
                  : undefined;

            return {
                ok: true,
                user: user.username,
                expiresAt,
                premiumDaysRemaining
            };
        } catch (err) {
            const kind = this.classifyError(err);
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'check failed',
                errorKind: kind
            };
        }
    }

    async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
        const res = await this.checkCredentials();
        return { ok: res.ok, user: res.user, error: res.error };
    }

    async resolveCached(input: ResolveInput): Promise<DebridResolution> {
        if (!isValidInfoHash(input.infoHash)) {
            return {
                kind: 'invalid-torrent',
                reason: `Invalid infoHash format: ${input.infoHash}`
            };
        }

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

            const selection = scoreAndSelectFile(files, {
                fileIdx: input.fileIdx,
                season: input.season,
                episode: input.episode,
                title: input.title
            });

            if (selection.index < 0) {
                await this.cleanup(torrentId);
                return {
                    kind: 'invalid-torrent',
                    reason: 'No playable video files found in torrent'
                };
            }

            const targetRdId = info.files[selection.index]?.id;

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
                    await this.cleanup(torrentId);
                    return {
                        kind: 'invalid-torrent',
                        reason: `Real-Debrid reports torrent error status: ${info.status}`
                    };
                }
                await delay(400);
            }

            if (info.status !== 'downloaded' || info.links.length === 0) {
                // Not instantly cached
                if (input.allowUncached) {
                    return {
                        kind: 'uncached',
                        torrentId,
                        progress: info.progress ?? 0,
                        status: info.status
                    };
                }
                // Default fast path: clean up so account does not accumulate unneeded slots
                await this.cleanup(torrentId);
                return { kind: 'uncached' };
            }

            const link = info.links[0];
            const unrestricted = await this.rd<{ download?: string }>(
                '/unrestrict/link',
                { form: { link } }
            );

            if (!unrestricted.download) {
                await this.cleanup(torrentId);
                return {
                    kind: 'provider-error',
                    code: 'UNRESTRICT_FAILED',
                    errorKind: 'unknown',
                    retryable: true,
                    safeMessage: 'Failed to obtain direct download link'
                };
            }

            return {
                kind: 'resolved',
                url: unrestricted.download,
                selectedFile: selection,
                cached: true
            };
        } catch (err) {
            if (torrentId && !input.allowUncached) {
                await this.cleanup(torrentId);
            }
            const kind = this.classifyError(err);
            return {
                kind: 'provider-error',
                code: 'RESOLVE_FAILED',
                errorKind: kind,
                retryable: isRetryableErrorKind(kind),
                safeMessage: 'Failed to resolve torrent on Real-Debrid'
            };
        }
    }

    async pollTransferStatus(
        torrentId: string,
        opts?: {
            fileIdx?: number;
            season?: number;
            episode?: number;
            title?: string;
        }
    ): Promise<DebridResolution> {
        try {
            const info = await this.rd<RdTorrentInfo>(
                `/torrents/info/${torrentId}`
            );

            if (
                ['magnet_error', 'error', 'virus', 'dead'].includes(info.status)
            ) {
                await this.cleanup(torrentId);
                return {
                    kind: 'invalid-torrent',
                    reason: `Real-Debrid reports torrent error status: ${info.status}`
                };
            }

            if (
                info.status === 'downloaded' &&
                info.links &&
                info.links.length > 0
            ) {
                const files = info.files.map((f) => ({
                    name: f.path,
                    size: f.bytes
                }));
                const selection = scoreAndSelectFile(files, opts ?? {});
                const link = info.links[0];
                const unrestricted = await this.rd<{ download?: string }>(
                    '/unrestrict/link',
                    { form: { link } }
                );

                if (!unrestricted.download) {
                    return {
                        kind: 'provider-error',
                        code: 'UNRESTRICT_FAILED',
                        errorKind: 'unknown',
                        retryable: true,
                        safeMessage: 'Failed to obtain direct download link'
                    };
                }

                return {
                    kind: 'resolved',
                    url: unrestricted.download,
                    selectedFile: selection,
                    cached: false
                };
            }

            return {
                kind: 'uncached',
                torrentId,
                progress: info.progress ?? 0,
                status: info.status
            };
        } catch (err) {
            const kind = this.classifyError(err);
            return {
                kind: 'provider-error',
                code: 'POLL_TRANSFER_FAILED',
                errorKind: kind,
                retryable: isRetryableErrorKind(kind),
                safeMessage: 'Failed to poll transfer status from Real-Debrid'
            };
        }
    }

    async resolve(input: ResolveInput): Promise<string | null> {
        const res = await this.resolveCached(input);
        if (res.kind === 'resolved') return res.url;
        return null;
    }

    async cleanup(id: string): Promise<void> {
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
