/**
 * Import a user's entire Stremio addon collection from their Stremio account.
 *
 * Uses the official Stremio API (https://api.strem.io):
 *   POST /api/login              { email, password }        → { authKey, user }
 *   POST /api/addonCollectionGet { authKey, update: true }  → { addons: [...] }
 *
 * Each request body is `{ authKey, ...params }` with content-type application/json;
 * the response is `{ result, error }` (throw on `error`). This mirrors the
 * official `stremio-api-client`.
 *
 * The Stremio API is never IP-blocked, so these calls bypass the egress proxy.
 */
import { scrapeFetch } from '../egress/scrapeFetch.js';
import type { AddonManager, InstallResult } from '../addons/manager.js';

const DEFAULT_ENDPOINT = 'https://api.strem.io';

interface StremioApiError {
    code?: number;
    message?: string;
}

async function apiRequest<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    authKey: string | null,
    endpoint = DEFAULT_ENDPOINT
): Promise<T> {
    const url = `${endpoint.replace(/\/$/, '')}/api/${method}`;
    const res = await scrapeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authKey, ...params }),
        viaProxy: false,
        timeoutMs: 15_000
    });
    if (!res.ok) {
        throw new Error(`Stremio API '${method}' failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
        result?: T;
        error?: string | StremioApiError;
    };
    if (body.error) {
        const msg =
            typeof body.error === 'string'
                ? body.error
                : body.error.message || 'Stremio API error';
        throw new Error(msg);
    }
    if (body.result === undefined) {
        throw new Error(`Stremio API '${method}' returned no result`);
    }
    return body.result;
}

/** Log in with email/password and return a session authKey. */
export async function stremioLogin(
    email: string,
    password: string,
    endpoint = DEFAULT_ENDPOINT
): Promise<string> {
    const result = await apiRequest<{ authKey?: string }>(
        'login',
        { email, password },
        null,
        endpoint
    );
    if (!result.authKey) {
        throw new Error('Login succeeded but no authKey was returned');
    }
    return result.authKey;
}

export interface StremioCollectionEntry {
    transportUrl: string;
    name?: string;
}

/** Fetch the addon collection for an authKey. */
export async function getAddonCollection(
    authKey: string,
    endpoint = DEFAULT_ENDPOINT
): Promise<StremioCollectionEntry[]> {
    const result = await apiRequest<{
        addons?: Array<{ transportUrl?: string; manifest?: { name?: string } }>;
    }>('addonCollectionGet', { update: true }, authKey, endpoint);
    const addons = Array.isArray(result.addons) ? result.addons : [];
    return addons
        .filter((a) => typeof a.transportUrl === 'string' && a.transportUrl)
        .map((a) => ({
            transportUrl: a.transportUrl as string,
            name: a.manifest?.name
        }));
}

export interface StremioImportOptions {
    email?: string;
    password?: string;
    authKey?: string;
    endpoint?: string;
}

export interface StremioImportResult {
    installed: number;
    failed: number;
    total: number;
    results: InstallResult[];
    collection: StremioCollectionEntry[];
}

/**
 * Import all addons from a Stremio account. Provide either an existing
 * `authKey`, or `email` + `password` to log in first.
 */
export async function importFromStremioAccount(
    manager: AddonManager,
    opts: StremioImportOptions
): Promise<StremioImportResult> {
    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    let authKey = opts.authKey;
    if (!authKey) {
        if (!opts.email || !opts.password) {
            throw new Error('Provide either authKey or email + password');
        }
        authKey = await stremioLogin(opts.email, opts.password, endpoint);
    }

    const collection = await getAddonCollection(authKey, endpoint);
    const urls = collection.map((c) => c.transportUrl);
    const results = await manager.installMany(urls, 'stremio-account');

    const installed = results.filter((r) => r.ok).length;
    return {
        installed,
        failed: results.length - installed,
        total: results.length,
        results,
        collection
    };
}
