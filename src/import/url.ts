/**
 * Import addon(s) from one or more manifest / transport URLs.
 */
import type { AddonManager, InstallResult } from '../addons/manager.js';

export async function importFromUrl(
    manager: AddonManager,
    url: string
): Promise<InstallResult> {
    return manager.install(url, 'url');
}

export async function importFromUrls(
    manager: AddonManager,
    urls: string[]
): Promise<InstallResult[]> {
    const clean = urls.map((u) => u.trim()).filter(Boolean);
    return manager.installMany(clean, 'url');
}
