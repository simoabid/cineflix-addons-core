/**
 * Debrid service singleton.
 *
 * Holds the active resolver + a short-TTL cache of resolved links, and is shared
 * by every StremioAddonProvider so torrent streams become playable HTTP sources.
 * Reconfigured at runtime when the admin updates debrid settings.
 */
import { RealDebridResolver } from './realdebrid.js';
import { AllDebridResolver } from './alldebrid.js';
import { PremiumizeResolver } from './premiumize.js';
import type {
    DebridConfig,
    DebridProviderId,
    DebridResolver,
    ResolveInput
} from './types.js';

interface CacheEntry {
    url: string;
    expires: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — debrid links stay valid a while.
const CACHE_MAX = 500;

class DebridService {
    private resolver: DebridResolver | null = null;
    private config: DebridConfig = { provider: 'none', apiKey: '', source: 'none' };
    private cache = new Map<string, CacheEntry>();

    configure(config: DebridConfig): void {
        this.config = { ...config };
        this.cache.clear();
        this.resolver = createResolver(config);
    }

    isEnabled(): boolean {
        return this.resolver !== null;
    }

    /** Safe status (never leaks the API key). */
    status(): {
        provider: DebridProviderId;
        enabled: boolean;
        hasKey: boolean;
        source: string;
    } {
        return {
            provider: this.config.provider,
            enabled: this.isEnabled(),
            hasKey: Boolean(this.config.apiKey),
            source: this.config.source ?? 'none'
        };
    }

    async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
        if (!this.resolver) return { ok: false, error: 'No debrid configured' };
        return this.resolver.check();
    }

    async resolve(input: ResolveInput): Promise<string | null> {
        if (!this.resolver) return null;
        const key = this.cacheKey(input);
        const hit = this.cache.get(key);
        if (hit && hit.expires > Date.now()) return hit.url;

        const url = await this.resolver.resolve(input);
        if (url) this.setCache(key, url);
        return url;
    }

    private cacheKey(input: ResolveInput): string {
        const variant =
            input.fileIdx != null
                ? `f${input.fileIdx}`
                : input.season != null
                  ? `s${input.season}e${input.episode}`
                  : 'm';
        return `${this.config.provider}:${input.infoHash}:${variant}`;
    }

    private setCache(key: string, url: string): void {
        if (this.cache.size >= CACHE_MAX) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }
        this.cache.set(key, { url, expires: Date.now() + CACHE_TTL_MS });
    }
}

export function createResolver(config: DebridConfig): DebridResolver | null {
    if (!config.apiKey || config.provider === 'none') return null;
    switch (config.provider) {
        case 'realdebrid':
            return new RealDebridResolver(config.apiKey);
        case 'alldebrid':
            return new AllDebridResolver(config.apiKey);
        case 'premiumize':
            return new PremiumizeResolver(config.apiKey);
        default:
            return null;
    }
}

/** Process-wide shared instance. */
export const debridService = new DebridService();
