/**
 * Ordering for addon providers.
 *
 * Unlike cineflix-core's hand-tuned per-scraper tier list, addons are
 * user-installed, so priority is simply the user-controlled `order` field
 * (lower = tried first in the frontend waterfall). Ties break by name.
 */
import type { InstalledAddon } from './addons/types.js';

export const DEFAULT_ADDON_TIMEOUT_MS = 20_000;

export function compareAddons(a: InstalledAddon, b: InstalledAddon): number {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
}

/** Sorted best-first (enabled or not). */
export function sortAddons(addons: InstalledAddon[]): InstalledAddon[] {
    return [...addons].sort(compareAddons);
}

/** Assign a contiguous priority index (0-based) to each provider id. */
export function priorityIndexMap(
    addons: InstalledAddon[]
): Map<string, number> {
    const map = new Map<string, number>();
    sortAddons(addons).forEach((a, i) => map.set(a.providerId, i));
    return map;
}
