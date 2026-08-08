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
import { fetchManifest, normalizeAddonUrl } from '../stremio/client.js';
import { StremioAddonProvider } from '../stremio/addonProvider.js';
import type { StremioManifest, StremioResource } from '../stremio/protocol.js';
import { createAddonStore, type AddonStore } from './store.js';
import {
    type AddonStoreData,
    type AddonValidationFinding,
    type AppSettings,
    type InstalledAddon,
    defaultSettings
} from './types.js';
import { DEFAULT_ADDON_TIMEOUT_MS, sortAddons } from '../priority.js';
import { debridService } from '../debrid/service.js';
import type { DebridProviderId } from '../debrid/types.js';
import type { AppConfig } from '../config.js';
import { createSecretBox, type SecretBox } from '../security/secrets.js';
import type { PlaybackGrantStore } from '../security/playbackGrant.js';
import { redactUrl } from '../security/redaction.js';
import {
    assertUrlSyntax,
    UrlPolicyError,
    type UrlPolicyOptions
} from '../security/urlPolicy.js';
import {
    deriveCapabilities,
    isStreamCapable,
    isSubtitleCapable,
    type AddonCapabilities
} from '../capabilities/index.js';
import { parseAddonUrl } from '../stremio/url.js';

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

export interface InstallOptions {
    /** Force-enable even when production defaults to disabled-on-install. */
    enable?: boolean;
    /** Idempotency key for dedupe across retries (optional). */
    idempotencyKey?: string;
    /** Optional abort signal to cancel a batch import mid-flight. */
    signal?: AbortSignal;
}

export interface InstallResult {
    ok: boolean;
    addon?: InstalledAddon;
    error?: string;
    /** true when the URL was already installed (updated in place). */
    updated?: boolean;
    findings?: AddonValidationFinding[];
}

function hasResource(manifest: StremioManifest, name: string): boolean {
    const resources = manifest.resources;
    if (!Array.isArray(resources)) return false;
    return resources.some((r: StremioResource) =>
        typeof r === 'string' ? r === name : r?.name === name
    );
}

function capabilitiesFor(manifest: StremioManifest): AddonCapabilities {
    return deriveCapabilities(manifest);
}

function redactPathForPublic(url: string): string {
    try {
        const u = new URL(url);
        // Redact path segments that look like opaque addon configuration:
        // long base64/JWT-like tokens (>=20 chars, base64url charset) commonly used in
        // path-configured addons (e.g. torrentio.strem.fun/<base64>/manifest.json).
        // Keep short human-readable segments (catalog, meta, etc.) intact.
        const parts = u.pathname.split('/').map((seg) => {
            if (!seg) return seg;
            if (seg === 'manifest.json') return seg;
            // Heuristic: long opaque token
            if (seg.length >= 20 && /^[A-Za-z0-9_-]+={0,2}$/.test(seg) && /[A-Za-z0-9_-]{20,}/.test(seg)) {
                // Additional check: contains mixed case + digits or padding, not a plain word
                if (!/^[a-z]+$/.test(seg) && !/^[A-Z]+$/.test(seg)) return '[REDACTED]';
            }
            // Hex-like long token
            if (seg.length >= 20 && /^[0-9a-fA-F]{20,}$/.test(seg)) return '[REDACTED]';
            return seg;
        });
        u.pathname = parts.join('/') || '/';
        return u.toString();
    } catch {
        return url;
    }
}

function urlLooksSecretBearing(url: string): boolean {
    // Treat ANY query or fragment as sensitive: addon transport URLs often carry
    // arbitrary configuration, signatures, or opaque tokens that are not captured
    // by a narrow key regex. Query values and fragments can be replayed.
    try {
        const u = new URL(url);
        if (u.search && u.search !== '?') return true;
        if (u.hash && u.hash !== '#' && u.hash.length > 1) return true;
        // Also keep the original narrow check for username/password and sensitive keys
        for (const key of u.searchParams.keys()) {
            if (/token|key|secret|auth|pass|api/i.test(key)) return true;
        }
        if (u.username || u.password) return true;
        return false;
    } catch {
        // Fallback: simple string check for ? or # with content
        if (url.includes('?') && url.split('?')[1].length > 0) return true;
        if (url.includes('#') && url.split('#')[1].length > 0) return true;
        return false;
    }
}

export class AddonManager {
    private data: AddonStoreData = { version: 1, addons: [], revision: 0 };
    private lock: Promise<unknown> = Promise.resolve();
    private readonly secrets: SecretBox;
    private grants: PlaybackGrantStore | null = null;
    private publicBase = '';
    private onRevisionBump?: (rev: number) => void;
    private onRevisionBumpAsync?: (rev: number) => Promise<void>;

    constructor(
        private readonly registry: ProviderRegistry,
        private readonly store: AddonStore,
        private readonly cfg: AppConfig
    ) {
        this.secrets = createSecretBox(cfg.secretsMasterKey);
    }

    static create(registry: ProviderRegistry, cfg: AppConfig): AddonManager {
        return new AddonManager(registry, createAddonStore(cfg), cfg);
    }

    /** Wire secure playback grants used when providers create source URLs. */
    setPlaybackGrants(grants: PlaybackGrantStore, publicBase: string): void {
        this.grants = grants;
        this.publicBase = publicBase.replace(/\/$/, '');
        // Re-register enabled providers so they pick up the grant store.
        for (const addon of this.data.addons) {
            if (addon.enabled) {
                this.unregisterProvider(addon.providerId);
                this.registerProvider(addon);
            }
        }
    }

    /** Register a hook to clear bulk/OMSS caches when revision changes. */
    setRevisionHook(fn: (rev: number) => void | Promise<void>): void {
        this.onRevisionBump = fn as (rev: number) => void;
        this.onRevisionBumpAsync = async (rev: number) => {
            const r = fn(rev);
            if (r instanceof Promise) await r;
        };
    }

    describeStore(): string {
        return this.store.describe();
    }

    getRevision(): number {
        return this.data.revision ?? 0;
    }

    private async bumpRevision(): Promise<void> {
        this.data.revision = (this.data.revision ?? 0) + 1;
        const rev = this.data.revision;
        if (this.onRevisionBumpAsync) {
            try {
                await this.onRevisionBumpAsync(rev);
            } catch {
                /* ignore */
            }
        } else if (this.onRevisionBump) {
            try {
                this.onRevisionBump(rev);
            } catch {
                /* ignore */
            }
        }
    }

    urlPolicy(): UrlPolicyOptions {
        return {
            allowHttp: this.cfg.allowHttpUpstreams,
            hostAllowlist:
                this.cfg.outboundHostAllowlist.length > 0
                    ? this.cfg.outboundHostAllowlist
                    : undefined,
            allowHostSuffixes: this.cfg.outboundHostAllowSuffixes,
            allowCredentials: false,
            maxLength: 2048
        };
    }

    private sealSensitiveUrl(url: string): string {
        if (!url) return url;
        if (this.secrets.isSealed(url)) return url;
        if (urlLooksSecretBearing(url)) {
            try {
                return this.secrets.seal(url);
            } catch {
                return url;
            }
        }
        return url;
    }

    private openSensitiveUrl(stored: string): string {
        if (!stored) return stored;
        if (this.secrets.isSealed(stored)) {
            try {
                return this.secrets.open(stored);
            } catch {
                return stored;
            }
        }
        return stored;
    }

    private openAddonUrls(addon: InstalledAddon): void {
        addon.manifestUrl = this.openSensitiveUrl(addon.manifestUrl);
        addon.baseUrl = this.openSensitiveUrl(addon.baseUrl);
        if (addon.originalImportUrl) {
            addon.originalImportUrl = this.openSensitiveUrl(
                addon.originalImportUrl
            );
        }
    }

    /** Load persisted addons and register providers for enabled ones. */
    async init(): Promise<void> {
        this.data = await this.store.load();
        if (this.data.revision == null) this.data.revision = 0;

        // Open any sealed URLs for runtime use
        for (const addon of this.data.addons) {
            this.openAddonUrls(addon);
            // Backfill capabilities if missing (migration from pre-Phase-2 stores).
            if (!addon.capabilities) {
                addon.capabilities = capabilitiesFor(addon.manifest);
            }
        }

        // Migrate plaintext debrid keys → sealed form on load.
        // Also migrate plaintext secret-bearing URLs → sealed form
        let needsSave = false;
        const settings = this.data.settings ?? defaultSettings();
        if (
            settings.debrid?.apiKey &&
            !this.secrets.isSealed(settings.debrid.apiKey)
        ) {
            settings.debrid = {
                ...settings.debrid,
                apiKey: this.secrets.seal(settings.debrid.apiKey)
            };
            this.data.settings = settings;
            needsSave = true;
        }
        for (const addon of this.data.addons) {
            if (
                urlLooksSecretBearing(addon.originalImportUrl ?? '') &&
                !this.secrets.isSealed(addon.originalImportUrl ?? '')
            ) {
                // Will be sealed on next persist; mark needsSave to rewrite file with sealed form
                needsSave = true;
            }
            if (
                urlLooksSecretBearing(addon.manifestUrl) &&
                !this.secrets.isSealed(addon.manifestUrl)
            ) {
                needsSave = true;
            }
            if (
                urlLooksSecretBearing(addon.baseUrl) &&
                !this.secrets.isSealed(addon.baseUrl)
            ) {
                needsSave = true;
            }
        }
        if (needsSave) {
            try {
                await this.persist();
            } catch {
                /* non-fatal */
            }
        }

        sortAddons(this.data.addons).forEach((a, i) => (a.order = i));
        // Recompute capabilities for any addon that may have been updated
        // while we were sealing; ensure every record has up-to-date caps.
        for (const a of this.data.addons) {
            a.capabilities = capabilitiesFor(a.manifest);
        }
        // Register ONLY stream-capable enabled addons as OMSS providers.
        for (const addon of this.data.addons) {
            if (addon.enabled && addon.capabilities && isStreamCapable(addon.capabilities)) {
                this.registerProvider(addon);
            }
        }
        console.log(
            `[addons] Loaded ${this.data.addons.length} addon(s) from ${this.store.describe()} ` +
                `(${this.data.addons.filter((a) => a.enabled).length} enabled, rev=${this.getRevision()})`
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
            .filter((a) => a.enabled && a.capabilities && isStreamCapable(a.capabilities))
            .map((a) => a.providerId);
    }

    getEnabled(): InstalledAddon[] {
        return sortAddons(this.data.addons).filter((a) => a.enabled);
    }

    /** Enabled AND stream-capable — the authoritative stream waterfall set. */
    getStreamEnabled(): InstalledAddon[] {
        return sortAddons(this.data.addons).filter(
            (a) => a.enabled && a.capabilities && isStreamCapable(a.capabilities)
        );
    }

    /** Enabled AND subtitle-capable — used by subtitle aggregation. */
    getSubtitleEnabled(): InstalledAddon[] {
        return sortAddons(this.data.addons).filter(
            (a) => a.enabled && a.capabilities && isSubtitleCapable(a.capabilities)
        );
    }

    /** Reconcile registry state atomically after a mutation. */
    reconcileRegistry(): void {
        // Ensure registry exactly matches the desired stream-enabled set,
        // in priority order. This avoids windows where storage, registry,
        // and cache disagree.
        const desired = new Set(this.getStreamEnabled().map((a) => a.providerId));
        // Remove stale
        for (const pid of this.registry.listProviders()) {
            if (!desired.has(pid) && pid.startsWith('addon:')) {
                this.unregisterProvider(pid);
            }
        }
        // Re-register in order — insertion order now equals business priority.
        // Clear and re-register sorted to keep Map order deterministic.
        const ordered = this.getStreamEnabled();
        // Check if order already matches registry insertion order; if not, rebuild.
        const currentOrder = this.registry
            .getProviders()
            .filter((p) => p.id.startsWith('addon:'))
            .map((p) => p.id);
        const needsReorder =
            currentOrder.length !== ordered.length ||
            currentOrder.some((id, i) => id !== ordered[i].providerId);
        if (needsReorder) {
            for (const pid of currentOrder) this.unregisterProvider(pid);
            for (const addon of ordered) this.registerProvider(addon);
        } else {
            // Ensure any missing are added
            for (const addon of ordered) {
                if (!this.registry.hasProvider(addon.providerId)) {
                    this.registerProvider(addon);
                }
            }
        }
    }

    // ── settings + debrid ─────────────────────────────────────────────────────

    getSettings(): AppSettings {
        return this.data.settings ?? defaultSettings();
    }

    /** Open the debrid API key for runtime use (never expose via API). */
    private openDebridKey(stored: string): string {
        if (!stored) return '';
        try {
            return this.secrets.open(stored);
        } catch (err) {
            console.error(
                '[debrid] failed to decrypt api key:',
                err instanceof Error ? err.message : err
            );
            return '';
        }
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
        const apiKey = this.openDebridKey(d.apiKey);
        debridService.configure({
            provider: d.provider,
            apiKey,
            source: apiKey && d.provider !== 'none' ? 'store' : 'none'
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
            if (patch.apiKey != null) {
                // Seal at rest; empty string clears.
                debrid.apiKey = patch.apiKey
                    ? this.secrets.seal(patch.apiKey)
                    : '';
            }
            this.data.settings = { ...settings, debrid };
            await this.bumpRevision();
            await this.persist();
            this.applyDebrid();
        });
    }

    setHealth(providerId: string, healthy: boolean, error?: string): void {
        const addon = this.get(providerId);
        if (!addon) return;
        addon.health = {
            healthy,
            lastChecked: nowIso(),
            ...(error ? { error } : {})
        };
        void this.persist();
    }

    // ── mutations (serialised) ──────────────────────────────────────────────

    private withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lock.then(fn, fn);
        this.lock = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    async install(
        url: string,
        source: InstalledAddon['source'] = 'url',
        options: InstallOptions = {}
    ): Promise<InstallResult> {
        return this.withLock(() => this.installInternal(url, source, options));
    }

    async installMany(
        urls: string[],
        source: InstalledAddon['source'],
        options: InstallOptions = {}
    ): Promise<InstallResult[]> {
        return this.withLock(async () => {
            const capped = urls.slice(0, this.cfg.importMaxUrls);
            const results: InstallResult[] = [];
            // Sequential under the lock keeps store consistent; concurrency
            // for fetches is handled by installInternal's own awaits.
            for (const url of capped) {
                if (options.signal?.aborted) {
                    throw Object.assign(
                        new Error('Import cancelled'),
                        { code: 'CANCELLED', name: 'AbortError' }
                    );
                }
                results.push(await this.installInternal(url, source, options));
            }
            if (urls.length > capped.length) {
                results.push({
                    ok: false,
                    error: `Import capped at ${this.cfg.importMaxUrls} URLs (received ${urls.length})`
                });
            }
            return results;
        });
    }

    private validateManifest(
        manifest: StremioManifest,
        originalUrl: string,
        manifestUrl: string
    ): AddonValidationFinding[] {
        const findings: AddonValidationFinding[] = [];

        // Strict manifest schema validation (P2)
        if (
            !manifest ||
            typeof manifest !== 'object' ||
            Array.isArray(manifest)
        ) {
            findings.push({
                code: 'invalid_manifest',
                message: 'Manifest is not an object',
                severity: 'error'
            });
            return findings;
        }
        if (
            !manifest.id ||
            typeof manifest.id !== 'string' ||
            !/^[a-z0-9._-]+$/i.test(manifest.id)
        ) {
            findings.push({
                code: 'invalid_manifest',
                message:
                    'Manifest is missing a valid string id (alphanumeric, dot, underscore, dash)',
                severity: 'error'
            });
        }
        if (
            manifest.name != null &&
            (typeof manifest.name !== 'string' || manifest.name.length > 200)
        ) {
            findings.push({
                code: 'invalid_manifest',
                message: 'Manifest name must be a string <= 200 chars',
                severity: 'error'
            });
        }
        if (
            manifest.version != null &&
            (typeof manifest.version !== 'string' ||
                !/^\d+\.\d+\.\d+/.test(manifest.version))
        ) {
            findings.push({
                code: 'invalid_manifest',
                message: 'Manifest version must be semver-like (e.g., 1.0.0)',
                severity: 'error'
            });
        }
        if (manifest.types != null) {
            if (
                !Array.isArray(manifest.types) ||
                manifest.types.some(
                    (t) =>
                        typeof t !== 'string' ||
                        !['movie', 'series', 'anime', 'tv'].includes(t)
                )
            ) {
                findings.push({
                    code: 'invalid_manifest',
                    message:
                        'Manifest types must be array of movie/series/anime/tv',
                    severity: 'error'
                });
            }
        }
        if (manifest.resources != null) {
            if (!Array.isArray(manifest.resources)) {
                findings.push({
                    code: 'invalid_manifest',
                    message: 'Manifest resources must be an array',
                    severity: 'error'
                });
            } else {
                for (const r of manifest.resources) {
                    const name =
                        typeof r === 'string'
                            ? r
                            : (r as { name?: unknown })?.name;
                    if (
                        typeof name !== 'string' ||
                        !['stream', 'subtitles', 'catalog', 'meta'].includes(
                            name
                        )
                    ) {
                        findings.push({
                            code: 'invalid_manifest',
                            message: `Invalid resource "${String(name)}": must be stream/subtitles/catalog/meta`,
                            severity: 'error'
                        });
                        break;
                    }
                }
            }
        }
        if (
            !hasResource(manifest, 'stream') &&
            !hasResource(manifest, 'subtitles')
        ) {
            findings.push({
                code: 'missing_stream_resource',
                message:
                    'Manifest advertises neither stream nor subtitles resources',
                severity: 'warning'
            });
        }
        if (
            urlLooksSecretBearing(originalUrl) ||
            urlLooksSecretBearing(manifestUrl)
        ) {
            findings.push({
                code: 'secret_bearing_url',
                message:
                    'Import URL appears to carry credentials or API keys in the query string',
                severity: 'warning'
            });
        }
        try {
            const u = new URL(manifestUrl);
            if (u.protocol === 'http:') {
                findings.push({
                    code: 'http_upstream',
                    message: 'Manifest is served over plain HTTP',
                    severity: this.cfg.allowHttpUpstreams ? 'warning' : 'error'
                });
            }
        } catch {
            findings.push({
                code: 'risky_url',
                message: 'Manifest URL could not be parsed',
                severity: 'error'
            });
        }

        const dup = this.data.addons.find(
            (a) =>
                a.manifestUrl === manifestUrl ||
                (manifest.id && a.manifest.id === manifest.id)
        );
        if (dup) {
            findings.push({
                code: 'duplicate_endpoint',
                message: `Matches existing addon ${dup.providerId}`,
                severity: 'info'
            });
        }

        if (findings.length === 0) {
            findings.push({
                code: 'ok',
                message: 'Manifest passed validation',
                severity: 'info'
            });
        }
        return findings;
    }

    private async installInternal(
        url: string,
        source: InstalledAddon['source'],
        options: InstallOptions = {}
    ): Promise<InstallResult> {
        if (options.signal?.aborted) {
            return {
                ok: false,
                error: 'Import cancelled',
                findings: [{ code: 'invalid_manifest', message: 'Import cancelled', severity: 'error' }]
            };
        }
        // Pre-validate URL syntax before any network call.
        try {
            assertUrlSyntax(
                // normalizeAddonUrl accepts bare hosts; feed a preview.
                url.trim().startsWith('stremio://')
                    ? 'https://' + url.trim().slice('stremio://'.length)
                    : /^https?:\/\//i.test(url.trim())
                      ? url.trim()
                      : 'https://' + url.trim(),
                this.urlPolicy()
            );
        } catch (err) {
            return {
                ok: false,
                error:
                    err instanceof UrlPolicyError
                        ? err.message
                        : err instanceof Error
                          ? err.message
                          : 'URL policy violation',
                findings: [
                    {
                        code: 'policy_violation',
                        message:
                            err instanceof Error
                                ? err.message
                                : 'policy violation',
                        severity: 'error'
                    }
                ]
            };
        }

        let manifest: StremioManifest;
        let baseUrl: string;
        let manifestUrl: string;
        let originalImportUrl = url.trim();
        try {
            const fetched = await fetchManifest(url, this.cfg.importTimeoutMs, {
                maxBytes: this.cfg.importMaxBytes,
                policy: this.urlPolicy(),
                signal: options.signal
            });
            manifest = fetched.manifest;
            baseUrl = fetched.baseUrl;
            manifestUrl = fetched.manifestUrl;
            originalImportUrl = fetched.originalUrl || originalImportUrl;
        } catch (err) {
            return {
                ok: false,
                error:
                    err instanceof Error
                        ? err.message
                        : 'Failed to fetch manifest',
                findings: [
                    {
                        code:
                            err instanceof UrlPolicyError
                                ? 'policy_violation'
                                : 'invalid_manifest',
                        message:
                            err instanceof Error ? err.message : 'fetch failed',
                        severity: 'error'
                    }
                ]
            };
        }

        const findings = this.validateManifest(
            manifest,
            originalImportUrl,
            manifestUrl
        );
        const hasError = findings.some((f) => f.severity === 'error');
        if (hasError) {
            return {
                ok: false,
                error: findings
                    .filter((f) => f.severity === 'error')
                    .map((f) => f.message)
                    .join('; '),
                findings
            };
        }

        const enable = options.enable ?? this.cfg.importEnableOnInstall ?? true;

        // Dedupe: same manifest URL or base → update in place (idempotent).
        // Dedupe by normalized fingerprint, not raw string equality.
        const incomingFp = (() => {
            try {
                return parseAddonUrl(manifestUrl).fingerprint;
            } catch {
                return manifestUrl;
            }
        })();
        const existing = this.data.addons.find((a) => {
            if (a.manifestUrl === manifestUrl || a.baseUrl === baseUrl) return true;
            try {
                return parseAddonUrl(a.manifestUrl).fingerprint === incomingFp;
            } catch {
                return false;
            }
        });
        if (existing) {
            existing.name = manifest.name || existing.name;
            existing.manifest = manifest;
            existing.baseUrl = baseUrl;
            existing.manifestUrl = manifestUrl;
            existing.originalImportUrl = originalImportUrl;
            existing.validationFindings = findings;
            existing.capabilities = capabilitiesFor(manifest);
            existing.admissionState = enable
                ? 'validated'
                : (existing.admissionState ?? 'validated');
            existing.updatedAt = nowIso();
            // Reconcile registry: re-register only if stream-capable
            if (existing.enabled) {
                this.unregisterProvider(existing.providerId);
                this.registerProvider(existing);
            }
            this.reconcileRegistry();
            await this.bumpRevision();
            await this.persist();
            return { ok: true, addon: existing, updated: true, findings };
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
            originalImportUrl,
            manifestUrl,
            baseUrl,
            enabled: enable,
            admissionState: enable ? 'validated' : 'pending',
            validationFindings: findings,
            capabilities: capabilitiesFor(manifest),
            order: maxOrder + 1,
            timeoutMs: DEFAULT_ADDON_TIMEOUT_MS,
            source,
            manifest,
            addedAt: nowIso(),
            updatedAt: nowIso()
        };
        this.data.addons.push(addon);
        this.reconcileRegistry();
        await this.bumpRevision();
        await this.persist();
        return { ok: true, addon, findings };
    }

    async remove(providerId: string): Promise<boolean> {
        return this.withLock(async () => {
            const idx = this.data.addons.findIndex(
                (a) => a.providerId === providerId
            );
            if (idx === -1) return false;
            this.unregisterProvider(providerId);
            this.data.addons.splice(idx, 1);
            await this.bumpRevision();
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
            addon.admissionState = enabled ? 'validated' : 'disabled';
            addon.updatedAt = nowIso();
            this.reconcileRegistry();
            await this.bumpRevision();
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
            // Timeout is captured at provider construction, so force re-registration
            // even when order/membership is unchanged.
            this.unregisterProvider(providerId);
            this.registerProvider(addon);
            this.reconcileRegistry();
            await this.bumpRevision();
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
            this.reconcileRegistry();
            await this.bumpRevision();
            await this.persist();
        });
    }

    async refresh(providerId: string): Promise<InstallResult> {
        const addon = this.get(providerId);
        if (!addon) return { ok: false, error: 'Addon not found' };
        const url = addon.originalImportUrl || addon.manifestUrl;
        return this.install(url, addon.source, { enable: addon.enabled });
    }

    // ── registry sync ────────────────────────────────────────────────────────

    private registerProvider(addon: InstalledAddon): void {
        // Only stream-capable addons participate in the OMSS provider registry.
        const caps = addon.capabilities ?? capabilitiesFor(addon.manifest);
        if (!isStreamCapable(caps)) return;
        if (!addon.enabled) return;
        if (this.registry.hasProvider(addon.providerId)) return;
        const provider = new StremioAddonProvider({
            providerId: addon.providerId,
            name: addon.name,
            baseUrl: addon.baseUrl,
            manifest: addon.manifest,
            enabled: addon.enabled,
            streamTimeoutMs: addon.timeoutMs,
            grants: this.grants ?? undefined,
            publicBase: this.publicBase || undefined,
            secureProxy: this.cfg.secureProxy,
            urlPolicy: this.urlPolicy()
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
            // Seal sensitive URLs before writing to disk; keep in-memory plain
            const snapshot: AddonStoreData = {
                ...this.data,
                addons: this.data.addons.map((a) => ({
                    ...a,
                    manifestUrl: this.sealSensitiveUrl(a.manifestUrl),
                    baseUrl: this.sealSensitiveUrl(a.baseUrl),
                    originalImportUrl: a.originalImportUrl
                        ? this.sealSensitiveUrl(a.originalImportUrl)
                        : undefined
                })),
                settings: this.data.settings
                    ? {
                          ...this.data.settings,
                          debrid: {
                              ...this.data.settings.debrid,
                              apiKey: this.data.settings.debrid.apiKey
                                  ? this.secrets.isSealed(
                                        this.data.settings.debrid.apiKey
                                    )
                                      ? this.data.settings.debrid.apiKey
                                      : this.secrets.seal(
                                            this.data.settings.debrid.apiKey
                                        )
                                  : ''
                          }
                      }
                    : undefined
            };
            await this.store.save(snapshot);
        } catch (err) {
            console.error(
                '[addons] Failed to persist store:',
                err instanceof Error ? err.message : err
            );
        }
    }
}

/** Public-safe view of an addon (redacts secret-bearing URLs and sealed values). */
export function toPublicAddon(a: InstalledAddon) {
    const safeUrl = (url: string): string => {
        if (!url) return url;
        if (url.startsWith('enc:v1:')) return '[REDACTED]';
        // First redact query/fragment, then path-configured opaque segments
        let r = redactUrl(url);
        try { r = redactPathForPublic(r); } catch { /* ignore */ }
        return r;
    };
    const caps = a.capabilities ?? deriveCapabilities(a.manifest);
    return {
        id: a.providerId,
        slug: a.slug,
        name: a.name,
        enabled: a.enabled,
        order: a.order,
        timeoutMs: a.timeoutMs,
        source: a.source,
        manifestUrl: safeUrl(a.manifestUrl),
        baseUrl: safeUrl(a.baseUrl),
        originalImportUrl: a.originalImportUrl
            ? safeUrl(a.originalImportUrl)
            : undefined,
        admissionState:
            a.admissionState ?? (a.enabled ? 'validated' : 'disabled'),
        validationFindings: a.validationFindings,
        capabilities: {
            stream: caps.stream,
            subtitles: caps.subtitles,
            catalog: caps.catalog,
            meta: caps.meta,
            status: caps.status,
            statusReason: caps.statusReason
        },
        // Back-compat flat fields for older clients
        types: a.manifest.types ?? [],
        resources: (a.manifest.resources ?? []).map((r) =>
            typeof r === 'string' ? r : r.name
        ),
        version: a.manifest.version ?? null,
        description: a.manifest.description ?? '',
        logo: a.manifest.logo ?? null,
        health: a.health ?? null,
        addedAt: a.addedAt,
        updatedAt: a.updatedAt
    };
}

// Re-export for callers that previously imported normalize only via client.
export { normalizeAddonUrl };
