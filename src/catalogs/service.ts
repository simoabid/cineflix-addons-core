/**
 * CatalogService — Phase 12 §15.1 catalog and metadata passthrough.
 *
 * Fetches and caches addon catalogs for CINEFLIX/admin browsing:
 *   GET {addon}/catalog/{type}/{catalogId}.json?extra...
 *
 * Design rules from the delivery plan:
 *  - Respect resource-level type/prefix rules: only addons that advertise a
 *    `catalog` resource (and whose manifest declares the descriptor) serve
 *    catalogs, and requests are matched against declared descriptors.
 *  - Catalog-only addons serve catalogs but are never added to the stream
 *    waterfall (capability model already guarantees this).
 *  - Entries are provider-namespaced and normalized (see normalization.ts).
 *  - Every page is cached (revision-aware key) with a bounded TTL and item cap.
 */
import type { AddonManager } from '../addons/manager.js';
import type { InstalledAddon } from '../addons/types.js';
import type { CacheManager } from '../cache/manager.js';
import { buildCatalogKey } from '../cache/namespaces.js';
import type { UrlPolicyOptions } from '../security/urlPolicy.js';
import { fetchCatalog } from '../stremio/client.js';
import type { StremioManifestCatalog } from '../stremio/protocol.js';
import {
    extraKey,
    normalizeCatalogEntries,
    type NormalizedCatalogEntry
} from './normalization.js';

export interface CatalogDescriptorView {
    addonSlug: string;
    providerId: string;
    addonName: string;
    type: string;
    catalogId: string;
    name?: string;
    extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
}

export interface CatalogPage {
    addonSlug: string;
    providerId: string;
    type: string;
    catalogId: string;
    metas: NormalizedCatalogEntry[];
    cached: boolean;
}

export interface CatalogServiceOptions {
    /** Max entries per page (hard cap; also config `CATALOG_MAX_ITEMS`). */
    maxItems?: number;
    /** Cache TTL seconds for a fetched page. */
    ttlSec?: number;
    /** Upstream fetch timeout ms. */
    timeoutMs?: number;
    /** URL policy (defaults to dev-permissive for direct construction). */
    policy?: UrlPolicyOptions;
    signal?: AbortSignal;
}

export class CatalogNotFoundError extends Error {
    constructor(
        message: string,
        readonly statusCode = 404
    ) {
        super(message);
        this.name = 'CatalogNotFoundError';
    }
}

export class CatalogService {
    constructor(
        private readonly manager: AddonManager,
        private readonly cache?: CacheManager,
        private readonly options: CatalogServiceOptions = {}
    ) {}

    get revision(): number {
        return this.manager.getRevision();
    }

    /** All catalogs advertised by enabled, installed addons. */
    listCatalogs(): CatalogDescriptorView[] {
        const out: CatalogDescriptorView[] = [];
        for (const addon of this.manager.getEnabled()) {
            const caps = addon.capabilities;
            if (!caps || !caps.catalog) continue;
            for (const c of caps.catalogs ?? []) {
                out.push(toView(addon, c));
            }
        }
        return out;
    }

    /**
     * Fetch one catalog page (cached). Extra params honor the descriptor's
     * declared `extra` options: unknown params are dropped, required enum
     * params are defaulted from the first declared option.
     */
    async getCatalogPage(
        addonSlug: string,
        type: string,
        catalogId: string,
        extra: Record<string, string> = {},
        opts: CatalogServiceOptions = {}
    ): Promise<CatalogPage> {
        const addon = this.manager
            .getEnabled()
            .find((a) => a.slug === addonSlug || a.providerId === addonSlug);
        if (!addon) {
            throw new CatalogNotFoundError(`Unknown addon: ${addonSlug}`);
        }
        const caps = addon.capabilities;
        const descriptor = caps?.catalogs?.find(
            (c) => c.type === type && c.id === catalogId
        );
        if (!caps || !caps.catalog || !descriptor) {
            throw new CatalogNotFoundError(
                `Addon ${addonSlug} does not advertise catalog ${type}/${catalogId}`
            );
        }

        const cleanExtra = sanitizeExtra(descriptor, extra);
        const eKey = extraKey(cleanExtra);
        const rev = this.revision;
        const cacheKey = buildCatalogKey(rev, addonSlug, type, catalogId, eKey);

        const ttl = opts.ttlSec ?? this.options.ttlSec ?? 1800;
        const maxItems = opts.maxItems ?? this.options.maxItems ?? 100;

        if (this.cache) {
            const hit = await this.cache.get<CatalogPage>(cacheKey);
            if (hit) return { ...hit, cached: true };
        }

        const json = await fetchCatalog(addon.baseUrl, type, catalogId, {
            extra: cleanExtra,
            timeoutMs: opts.timeoutMs ?? this.options.timeoutMs ?? 12_000,
            policy: opts.policy ?? this.options.policy,
            signal: opts.signal ?? this.options.signal
        });

        const page: CatalogPage = {
            addonSlug,
            providerId: addon.providerId,
            type,
            catalogId,
            metas: normalizeCatalogEntries(json.metas, addon.providerId, {
                maxItems
            }),
            cached: false
        };

        const ttlFromAddon =
            typeof json.cacheMaxAge === 'number' && json.cacheMaxAge > 0
                ? Math.min(json.cacheMaxAge, ttl)
                : ttl;
        if (this.cache) {
            await this.cache.set(cacheKey, page, ttlFromAddon);
        }
        return page;
    }
}

function toView(
    addon: InstalledAddon,
    c: StremioManifestCatalog
): CatalogDescriptorView {
    return {
        addonSlug: addon.slug,
        providerId: addon.providerId,
        addonName: addon.name,
        type: c.type,
        catalogId: c.id,
        name: c.name,
        extra: c.extra
    };
}

/**
 * Keep only extra params the descriptor declares; default required enum
 * params. Stremio `extra` descriptors declare supported parameter names
 * (search, genre, skip, ...).
 */
export function sanitizeExtra(
    descriptor: StremioManifestCatalog,
    extra: Record<string, string>
): Record<string, string> {
    const declared = Array.isArray(descriptor.extra) ? descriptor.extra : [];
    const allowed = new Set(declared.map((e) => e.name));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) {
        if (allowed.has(k) && typeof v === 'string' && v.trim()) {
            out[k] = v.trim();
        }
    }
    for (const d of declared) {
        if (
            d.isRequired &&
            !out[d.name] &&
            Array.isArray(d.options) &&
            d.options.length
        ) {
            // First declared option defaults a required enum parameter.
            out[d.name] = d.options[0];
        }
    }
    return out;
}
