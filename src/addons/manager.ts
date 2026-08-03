/**
 * AddonManager — the source of truth for installed addons.
 *
 * Owns the in-memory list, persists via the store, and keeps the OMSS provider
 * registry in sync: one StremioAddonProvider is registered per ENABLED addon,
 * so enabled addons appear in `/v1/providers` and the progressive waterfall.
 *
 * All mutations are serialised through a simple lock to avoid store/registry
 * races when multiple imports land concurrently.
 */
import type { ProviderRegistry } from '@omss/framework';
import { fetchManifest } from '../stremio/client.js';
import { StremioAddonProvider } from '../stremio/addonProvider.js';
import type { StremioManifest } from '../stremio/protocol.js';
import { createAddonStore, type AddonStore } from './store.js';
import {
    type AddonStoreData,
    type AppSettings,
    type InstalledAddon,
    defaultSettings
} from './types.js';
import { DEFAULT_ADDON_TIMEOUT_MS, sortAddons } from '../priority.js';
import { debridService } from '../debrid/service.js';
import type { DebridProviderId } from '../debrid/types.js';
import type { AppConfig } from '../config.js';

function nowIso(): string {
    return new Date().toISOString();
}

function safeSlug(raw: string): string {
    return (
        raw
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'addon'
    );
}

export interface InstallResult {
    ok: boolean;
    addon?: InstalledAddon;
    error?: string;
    /** true when the URL was already installed (updated in place). */
    updated?: boolean;
}

export class AddonManager {
    private data: AddonStoreData = { version: 1, addons: [] };
    private lock: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly registry: ProviderRegistry,
        private readonly store: AddonStore,
        private readonly cfg: AppConfig
    ) {}

    static create(registry: ProviderRegistry, cfg: AppConfig): AddonManager {
        return new AddonManager(registry, createAddonStore(cfg), cfg);
    }

    describeStore(): string {
        return this.store.describe();
    }

    /** Load persisted addons and register providers for enabled ones. */
    async init(): Promise<void> {
        this.data = await this.store.load();
        // Normalise order to be contiguous + register enabled providers.
        sortAddons(this.data.addons).forEach((a, i) => (a.order = i));
        for (const addon of this.data.addons) {
            if (addon.enabled) this.registerProvider(addon);
        }
        console.log(
            `[addons] Loaded ${this.data.addons.length} addon(s) from ${this.store.describe()} ` +
                `(${this.data.addons.filter((a) => a.enabled).length} enabled)`
        );

        if (this.data.addons.length === 0 && this.cfg.seedUrls.length) {
            console.log(
                `[addons] Seeding ${this.cfg.seedUrls.length} addon(s) from ADDONS_SEED_URLS`
            );
            await this.installMany(this.cfg.seedUrls, 'seed');
        }

        this.applyDebrid();
        const ds = debridService.status();
        console.log(
            `[debrid] ${ds.enabled ? `ON provider=${ds.provider} (${ds.source})` : 'OFF'}`
        );
    }

    list(): InstalledAddon[] {
        return sortAddons(this.data.addons);
    }

    get(providerId: string): InstalledAddon | undefined {
        return this.data.addons.find((a) => a.providerId === providerId);
    }

    getTimeoutMs(providerId: string): number {
        return this.get(providerId)?.timeoutMs ?? DEFAULT_ADDON_TIMEOUT_MS;
    }

    orderedEnabledProviderIds(): string[] {
        return sortAddons(this.data.addons)
            .filter((a) => a.enabled)
            .map((a) => a.providerId);
    }

    getEnabled(): InstalledAddon[] {
        return sortAddons(this.data.addons).filter((a) => a.enabled);
    }

    // ── settings + debrid ─────────────────────────────────────────────────────

    getSettings(): AppSettings {
        return this.data.settings ?? defaultSettings();
    }

    /** Configure the shared debrid service. Env config wins over the store. */
    private applyDebrid(): void {
        if (this.cfg.debridApiKey && this.cfg.debridProvider !== 'none') {
            debridService.configure({
                provider: this.cfg.debridProvider as DebridProviderId,
                apiKey: this.cfg.debridApiKey,
                source: 'env'
            });
            return;
        }
        const d = this.getSettings().debrid;
        debridService.configure({
            provider: d.provider,
            apiKey: d.apiKey,
            source: d.apiKey && d.provider !== 'none' ? 'store' : 'none'
        });
    }

    /** True when debrid is pinned by env and can't be changed via the API. */
    debridLockedByEnv(): boolean {
        return Boolean(
            this.cfg.debridApiKey && this.cfg.debridProvider !== 'none'
        );
    }

    async updateDebridSettings(patch: {
        provider?: DebridProviderId;
        apiKey?: string;
    }): Promise<void> {
        return this.withLock(async () => {
            const settings = this.getSettings();
            const debrid = { ...settings.debrid };
            if (patch.provider != null) debrid.provider = patch.provider;
            if (patch.apiKey != null) debrid.apiKey = patch.apiKey;
            this.data.settings = { ...settings, debrid };
            await this.persist();
            this.applyDebrid();
        });
    }

    setHealth(
        providerId: string,
        healthy: boolean,
        error?: string
    ): void {
        const addon = this.get(providerId);
        if (!addon) return;
        addon.health = {
            healthy,
            lastChecked: nowIso(),
            ...(error ? { error } : {})
        };
        // Persist opportunistically; failures are logged, not fatal.
        void this.persist();
    }

    // ── mutations (serialised) ──────────────────────────────────────────────

    private withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lock.then(fn, fn);
        // Keep the chain alive but swallow errors so one failure doesn't wedge it.
        this.lock = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    async install(
        url: string,
        source: InstalledAddon['source'] = 'url'
    ): Promise<InstallResult> {
        return this.withLock(() => this.installInternal(url, source));
    }

    async installMany(
        urls: string[],
        source: InstalledAddon['source']
    ): Promise<InstallResult[]> {
        return this.withLock(async () => {
            const results: InstallResult[] = [];
            for (const url of urls) {
                results.push(await this.installInternal(url, source));
            }
            return results;
        });
    }

    private async installInternal(
        url: string,
        source: InstalledAddon['source']
    ): Promise<InstallResult> {
        let manifest: StremioManifest;
        let baseUrl: string;
        let manifestUrl: string;
        try {
            const fetched = await fetchManifest(url);
            manifest = fetched.manifest;
            baseUrl = fetched.baseUrl;
            // Recover canonical manifest url from base.
            manifestUrl = `${baseUrl.split('?')[0].replace(/\/$/, '')}/manifest.json`;
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'Failed to fetch manifest'
            };
        }

        // Dedupe: same manifest URL → update in place.
        const existing = this.data.addons.find(
            (a) => a.manifestUrl === manifestUrl || a.baseUrl === baseUrl
        );
        if (existing) {
            existing.name = manifest.name || existing.name;
            existing.manifest = manifest;
            existing.baseUrl = baseUrl;
            existing.updatedAt = nowIso();
            if (existing.enabled) {
                this.unregisterProvider(existing.providerId);
                this.registerProvider(existing);
            }
            await this.persist();
            return { ok: true, addon: existing, updated: true };
        }

        const providerId = this.uniqueProviderId(manifest, baseUrl);
        const maxOrder = this.data.addons.reduce(
            (m, a) => Math.max(m, a.order),
            -1
        );
        const addon: InstalledAddon = {
            providerId,
            slug: providerId.replace(/^addon:/, ''),
            name: manifest.name || providerId,
            manifestUrl,
            baseUrl,
            enabled: true,
            order: maxOrder + 1,
            timeoutMs: DEFAULT_ADDON_TIMEOUT_MS,
            source,
            manifest,
            addedAt: nowIso(),
            updatedAt: nowIso()
        };
        this.data.addons.push(addon);
        this.registerProvider(addon);
        await this.persist();
        return { ok: true, addon };
    }

    async remove(providerId: string): Promise<boolean> {
        return this.withLock(async () => {
            const idx = this.data.addons.findIndex(
                (a) => a.providerId === providerId
            );
            if (idx === -1) return false;
            this.unregisterProvider(providerId);
            this.data.addons.splice(idx, 1);
            await this.persist();
            return true;
        });
    }

    async setEnabled(
        providerId: string,
        enabled: boolean
    ): Promise<InstalledAddon | undefined> {
        return this.withLock(async () => {
            const addon = this.get(providerId);
            if (!addon) return undefined;
            addon.enabled = enabled;
            addon.updatedAt = nowIso();
            if (enabled) this.registerProvider(addon);
            else this.unregisterProvider(providerId);
            await this.persist();
            return addon;
        });
    }

    async setTimeout(
        providerId: string,
        timeoutMs: number
    ): Promise<InstalledAddon | undefined> {
        return this.withLock(async () => {
            const addon = this.get(providerId);
            if (!addon) return undefined;
            addon.timeoutMs = Math.max(1000, Math.min(120_000, timeoutMs));
            addon.updatedAt = nowIso();
            // Re-register so the provider picks up the new timeout.
            if (addon.enabled) {
                this.unregisterProvider(providerId);
                this.registerProvider(addon);
            }
            await this.persist();
            return addon;
        });
    }

    async reorder(orderedProviderIds: string[]): Promise<void> {
        return this.withLock(async () => {
            const rank = new Map(orderedProviderIds.map((id, i) => [id, i]));
            const fallbackBase = orderedProviderIds.length;
            this.data.addons.forEach((a, i) => {
                a.order = rank.has(a.providerId)
                    ? (rank.get(a.providerId) as number)
                    : fallbackBase + i;
            });
            sortAddons(this.data.addons).forEach((a, i) => (a.order = i));
            await this.persist();
        });
    }

    async refresh(providerId: string): Promise<InstallResult> {
        const addon = this.get(providerId);
        if (!addon) return { ok: false, error: 'Addon not found' };
        return this.install(addon.manifestUrl, addon.source);
    }

    // ── registry sync ────────────────────────────────────────────────────────

    private registerProvider(addon: InstalledAddon): void {
        if (this.registry.hasProvider(addon.providerId)) return;
        const provider = new StremioAddonProvider({
            providerId: addon.providerId,
            name: addon.name,
            baseUrl: addon.baseUrl,
            manifest: addon.manifest,
            enabled: addon.enabled,
            streamTimeoutMs: addon.timeoutMs
        });
        this.registry.register(provider);
    }

    private unregisterProvider(providerId: string): void {
        this.registry.unregister(providerId);
    }

    private uniqueProviderId(
        manifest: StremioManifest,
        baseUrl: string
    ): string {
        let host = '';
        try {
            host = new URL(baseUrl).hostname;
        } catch {
            /* ignore */
        }
        const base = safeSlug(manifest.id || host || 'addon');
        let candidate = `addon:${base}`;
        let n = 2;
        while (this.data.addons.some((a) => a.providerId === candidate)) {
            candidate = `addon:${base}-${n++}`;
        }
        return candidate;
    }

    private async persist(): Promise<void> {
        try {
            await this.store.save(this.data);
        } catch (err) {
            console.error(
                '[addons] Failed to persist store:',
                err instanceof Error ? err.message : err
            );
        }
    }
}
