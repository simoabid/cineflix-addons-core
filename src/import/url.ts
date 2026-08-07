/**
 * Import addon(s) from one or more manifest / transport URLs.
 */
import type {
    AddonManager,
    InstallOptions,
    InstallResult
} from '../addons/manager.js';

export async function importFromUrl(
    manager: AddonManager,
    url: string,
    options: InstallOptions = {}
): Promise<InstallResult> {
    return manager.install(url, 'url', options);
}

export async function importFromUrls(
    manager: AddonManager,
    urls: string[],
    options: InstallOptions = {}
): Promise<InstallResult[]> {
    const clean = urls.map((u) => u.trim()).filter(Boolean);
    return manager.installMany(clean, 'url', options);
}
