/**
 * AllDebrid resolver (API v4).
 *
 * Flow: upload magnet → (if ready/cached) status(links) → pick file → unlock.
 * Uncached magnets return typed 'uncached' resolution.
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

const BASE = 'https://api.alldebrid.com/v4';
const AGENT = 'addons-core';

function isRetryableErrorKind(kind: DebridErrorKind): boolean {
    return (
        kind === 'rate_limited' ||
        kind === 'network_error' ||
        kind === 'provider_down'
    );
}

interface AdEnvelope<T> {
    status: 'success' | 'error';
    data?: T;
    error?: { code?: string; message?: string };
}

interface AdUser {
    user?: {
        username?: string;
        email?: string;
        isPremium?: boolean;
        premiumUntil?: number; // unix timestamp
    };
}

export class AllDebridResolver implements DebridResolver {
    readonly id = 'alldebrid' as const;
    readonly name = 'AllDebrid';

    constructor(private readonly apiKey: string) {}

    getCapabilities(): DebridCapabilities {
        return {
            supportsInstantAvailabilityCheck: true,
            supportsFileSelection: true,
            supportsUncachedTransfers: true,
            supportsLinkExpiry: false
        };
    }

    getLinkExpiry(url: string): Date | undefined {
        try {
            const parsed = new URL(url);
            const expParam =
                parsed.searchParams.get('expires') ||
                parsed.searchParams.get('exp') ||
                parsed.searchParams.get('e');
            if (expParam) {
                const ts = parseInt(expParam, 10);
                if (!isNaN(ts) && ts > 0) {
                    return new Date(ts > 1e11 ? ts : ts * 1000);
                }
            }
        } catch {
            /* ignore invalid URL */
        }
        return undefined;
    }

    classifyError(err: unknown): DebridErrorKind {
        const msg = (
            err instanceof Error ? err.message : String(err)
        ).toLowerCase();
        if (
            msg.includes('auth_bad_apikey') ||
            msg.includes('auth_missing_apikey') ||
            msg.includes('auth_blocked') ||
            msg.includes('auth_user_banned') ||
            msg.includes('401') ||
            msg.includes('403')
        ) {
            return 'auth_failure';
        }
        if (msg.includes('429') || msg.includes('too_many_requests')) {
            return 'rate_limited';
        }
        if (
            msg.includes('magnet_invalid_id') ||
            msg.includes('magnet_must_be_completed') ||
            msg.includes('invalid_magnet')
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
            throw new Error(body.error?.message || `AllDebrid ${path} error`);
        }
        return body.data;
    }

    async checkCredentials(): Promise<DebridCheckResult> {
        try {
            const data = await this.ad<AdUser>('/user');
            const user = data.user;
            const expiresAt = user?.premiumUntil
                ? new Date(user.premiumUntil * 1000)
                : undefined;
            const premiumDaysRemaining = expiresAt
                ? Math.max(
                      0,
                      Math.floor(
                          (expiresAt.getTime() - Date.now()) / (86400 * 1000)
                      )
                  )
                : undefined;

            return {
                ok: true,
                user: user?.username,
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
        let magnetId: number | null = null;

        try {
            const uploaded = await this.ad<{
                magnets: Array<{
                    id: number;
                    ready?: boolean;
                    hash?: string;
                }>;
            }>('/magnet/upload', { 'magnets[]': magnet });

            const m = uploaded.magnets?.[0];
            if (!m) {
                return {
                    kind: 'invalid-torrent',
                    reason: 'Failed to upload magnet to AllDebrid'
                };
            }
            magnetId = m.id;

            if (m.ready === false) {
                if (input.allowUncached) {
                    return {
                        kind: 'uncached',
                        torrentId: String(m.id),
                        progress: 0
                    };
                }
                await this.cleanup(String(m.id));
                return { kind: 'uncached' };
            }

            const status = await this.ad<{
                magnets: {
                    links?: Array<{
                        link: string;
                        filename: string;
                        size: number;
                    }>;
                };
            }>('/magnet/status', { id: String(m.id) });

            const links = status.magnets?.links ?? [];
            if (links.length === 0) {
                await this.cleanup(String(m.id));
                return {
                    kind: 'invalid-torrent',
                    reason: 'No links available in AllDebrid magnet'
                };
            }

            const files = links.map((l) => ({
                name: l.filename,
                size: l.size
            }));

            const selection = scoreAndSelectFile(files, {
                fileIdx: input.fileIdx,
                season: input.season,
                episode: input.episode,
                title: input.title
            });

            if (selection.index < 0) {
                await this.cleanup(String(m.id));
                return {
                    kind: 'invalid-torrent',
                    reason: 'No playable video files found in torrent'
                };
            }

            const unlocked = await this.ad<{
                link?: string;
                delayed?: boolean;
            }>('/link/unlock', {
                link: links[selection.index].link
            });

            if (!unlocked.link) {
                await this.cleanup(String(m.id));
                return {
                    kind: 'provider-error',
                    code: 'UNLOCK_FAILED',
                    errorKind: 'unknown',
                    retryable: true,
                    safeMessage: 'Failed to unlock direct link from AllDebrid'
                };
            }

            return {
                kind: 'resolved',
                url: unlocked.link,
                selectedFile: selection,
                cached: true
            };
        } catch (err) {
            if (magnetId && !input.allowUncached) {
                await this.cleanup(String(magnetId));
            }
            const kind = this.classifyError(err);
            return {
                kind: 'provider-error',
                code: 'RESOLVE_FAILED',
                errorKind: kind,
                retryable: isRetryableErrorKind(kind),
                safeMessage: 'Failed to resolve torrent on AllDebrid'
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
            const status = await this.ad<{
                magnets: {
                    statusCode?: number;
                    status?: string;
                    ready?: boolean;
                    downloaded?: number;
                    size?: number;
                    links?: Array<{
                        link: string;
                        filename: string;
                        size: number;
                    }>;
                };
            }>('/magnet/status', { id: torrentId });

            const m = status.magnets;
            if (!m) {
                return {
                    kind: 'invalid-torrent',
                    reason: 'AllDebrid transfer not found'
                };
            }

            if (m.statusCode && m.statusCode >= 5) {
                await this.cleanup(torrentId);
                return {
                    kind: 'invalid-torrent',
                    reason: `AllDebrid transfer failed with status code ${m.statusCode}: ${m.status ?? 'error'}`
                };
            }

            if ((m.ready || (m.links && m.links.length > 0)) && m.links && m.links.length > 0) {
                const files = m.links.map((l) => ({
                    name: l.filename,
                    size: l.size
                }));
                const selection = scoreAndSelectFile(files, opts ?? {});
                if (selection.index < 0) {
                    await this.cleanup(torrentId);
                    return {
                        kind: 'invalid-torrent',
                        reason: 'No playable video files found in torrent'
                    };
                }
                const unlocked = await this.ad<{ link?: string }>('/link/unlock', {
                    link: m.links[selection.index].link
                });
                if (!unlocked.link) {
                    return {
                        kind: 'provider-error',
                        code: 'UNLOCK_FAILED',
                        errorKind: 'unknown',
                        retryable: true,
                        safeMessage: 'Failed to unlock direct link from AllDebrid'
                    };
                }
                return {
                    kind: 'resolved',
                    url: unlocked.link,
                    selectedFile: selection,
                    cached: false
                };
            }

            const progress =
                m.downloaded && m.size && m.size > 0
                    ? Math.round((m.downloaded / m.size) * 100)
                    : 0;

            return {
                kind: 'uncached',
                torrentId,
                progress,
                status: m.status
            };
        } catch (err) {
            const kind = this.classifyError(err);
            return {
                kind: 'provider-error',
                code: 'POLL_TRANSFER_FAILED',
                errorKind: kind,
                retryable: isRetryableErrorKind(kind),
                safeMessage: 'Failed to poll transfer status from AllDebrid'
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
            await this.ad('/magnet/delete', { id });
        } catch {
            /* best-effort cleanup */
        }
    }
}
