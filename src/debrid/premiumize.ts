/**
 * Premiumize resolver.
 *
 * `transfer/directdl` returns direct links immediately for cached content;
 * uncached magnets yield typed 'uncached' resolution.
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

const BASE = 'https://www.premiumize.me/api';

interface PmAccountInfo {
    status?: string;
    customer_id?: string;
    premium_until?: number; // unix timestamp
    limit_used?: number;
    space_used?: number;
}

export class PremiumizeResolver implements DebridResolver {
    readonly id = 'premiumize' as const;
    readonly name = 'Premiumize';

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
            msg.includes('not_logged_in') ||
            msg.includes('invalid api key') ||
            msg.includes('401') ||
            msg.includes('403')
        ) {
            return 'auth_failure';
        }
        if (msg.includes('429') || msg.includes('rate_limit')) {
            return 'rate_limited';
        }
        if (msg.includes('invalid_url') || msg.includes('invalid')) {
            return 'invalid_torrent';
        }
        if (
            msg.includes('500') ||
            msg.includes('502') ||
            msg.includes('503') ||
            msg.includes('504')
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

    async checkCredentials(): Promise<DebridCheckResult> {
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
            const data = (await res.json()) as PmAccountInfo;
            if (data.status !== 'success') {
                throw new Error('invalid api key');
            }

            const expiresAt = data.premium_until
                ? new Date(data.premium_until * 1000)
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
                user: data.customer_id,
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

            if (!res.ok) {
                const kind = this.classifyError(`HTTP ${res.status}`);
                return {
                    kind: 'provider-error',
                    code: 'PREMIUMIZE_HTTP_ERROR',
                    errorKind: kind,
                    retryable: kind === 'rate_limited',
                    safeMessage: `Premiumize responded with HTTP ${res.status}`
                };
            }

            const data = (await res.json()) as {
                status?: string;
                message?: string;
                content?: Array<{
                    path: string;
                    size: number;
                    link?: string;
                    stream_link?: string;
                }>;
            };

            if (data.status !== 'success' || !data.content?.length) {
                // Not cached
                if (input.allowUncached) {
                    return {
                        kind: 'uncached'
                    };
                }
                return { kind: 'uncached' };
            }

            const files = data.content.map((c) => ({
                name: c.path,
                size: Number(c.size) || 0
            }));

            const selection = scoreAndSelectFile(files, {
                fileIdx: input.fileIdx,
                season: input.season,
                episode: input.episode,
                title: input.title
            });

            if (selection.index < 0) {
                return {
                    kind: 'invalid-torrent',
                    reason: 'No playable video files found in torrent'
                };
            }

            const chosen = data.content[selection.index];
            const finalUrl = chosen.stream_link || chosen.link;

            if (!finalUrl) {
                return {
                    kind: 'provider-error',
                    code: 'NO_STREAM_LINK',
                    errorKind: 'unknown',
                    retryable: false,
                    safeMessage: 'No stream link provided by Premiumize'
                };
            }

            return {
                kind: 'resolved',
                url: finalUrl,
                selectedFile: selection,
                cached: true
            };
        } catch (err) {
            const kind = this.classifyError(err);
            return {
                kind: 'provider-error',
                code: 'PREMIUMIZE_API_ERROR',
                errorKind: kind,
                retryable: kind === 'network_error' || kind === 'rate_limited',
                safeMessage:
                    err instanceof Error ? err.message : 'Premiumize error'
            };
        }
    }

    async resolve(input: ResolveInput): Promise<string | null> {
        const res = await this.resolveCached(input);
        if (res.kind === 'resolved') return res.url;
        return null;
    }

    async cleanup(_id: string): Promise<void> {
        // Premiumize directdl creates ephemeral items unless added to transfers
    }
}
