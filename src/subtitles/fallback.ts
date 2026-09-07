/**
 * Subtitle fallback provider (Phase 12 §15.2).
 *
 * A disabled-by-default adapter for trusted third-party subtitle sources.
 * Operators enable it explicitly (`SUBTITLE_FALLBACK_ENABLED=true`) after
 * their own legal/operational review — the delivery plan requires that gate
 * before any third-party fallback ships enabled. The provider is a plain
 * URL template returning Stremio-shaped subtitle responses:
 *
 *   SUBTITLE_FALLBACK_URL=https://provider.example/search?imdb={imdbId}&lang={lang}&s={season}&e={episode}
 *
 * Placeholder tokens: {imdbId} {lang} {season} {episode}. Results are marked
 * with provenance `fallback` and only used when addon aggregation produced
 * nothing (or below `minResults`).
 */
import { secureFetch } from '../security/secureFetch.js';
import { type UrlPolicyOptions } from '../security/urlPolicy.js';
import type { StremioSubtitle } from '../stremio/protocol.js';

export interface SubtitleFallbackResult {
    subtitles: StremioSubtitle[];
    provider: string;
}

export interface SubtitleFallbackOptions {
    template: string;
    timeoutMs?: number;
    maxBytes?: number;
    policy?: UrlPolicyOptions;
    signal?: AbortSignal;
    /** Upstream identifier recorded in provenance (default: host name). */
    providerLabel?: string;
}

function renderTemplate(
    template: string,
    vars: Record<string, string | number | undefined>
): string | null {
    let out = template;
    for (const [k, v] of Object.entries(vars)) {
        const token = `{${k}}`;
        if (!out.includes(token)) continue;
        if (v == null || v === '') return null; // cannot satisfy required var
        out = out.split(token).join(encodeURIComponent(String(v)));
    }
    // Any remaining unresolved tokens make the template unusable for this query.
    if (/\{[a-z]+\}/i.test(out)) return null;
    return out;
}

export async function fetchFallbackSubtitles(
    opts: SubtitleFallbackOptions,
    vars: {
        imdbId?: string;
        lang?: string;
        season?: number;
        episode?: number;
    }
): Promise<SubtitleFallbackResult | null> {
    const url = renderTemplate(opts.template, vars);
    if (!url) return null;
    let host = 'fallback';
    try {
        host = new URL(url).host;
    } catch {
        return null;
    }
    try {
        const result = await secureFetch(url, {
            headers: { Accept: 'application/json' },
            timeoutMs: opts.timeoutMs ?? 10_000,
            maxBytes: opts.maxBytes ?? 512_000,
            maxRedirects: 3,
            acceptContentTypes: ['json'],
            policy: opts.policy ?? { allowHttp: false },
            viaProxy: 'auto',
            signal: opts.signal
        });
        if (!result.response.ok) return null;
        const json = (await result.response.json()) as {
            subtitles?: StremioSubtitle[];
        };
        const subs = Array.isArray(json?.subtitles) ? json.subtitles : [];
        return { subtitles: subs, provider: opts.providerLabel ?? host };
    } catch {
        // Fallbacks are best-effort by definition; never surface errors.
        return null;
    }
}
