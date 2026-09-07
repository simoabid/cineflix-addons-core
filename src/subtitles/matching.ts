/**
 * Subtitle match confidence (Phase 12 §15.2).
 *
 * Scores a candidate subtitle against the query context (0–100) with the
 * reasons visible to callers, so ranking stays explainable:
 *   language exact canonical match      +50 (primary-only match +35)
 *   season/episode match in id/url      +25
 *   release-name tokens in id/url       +10
 *   non-hearing-impaired preference     +10 when accessibility matters
 *   native format (srt/vtt)             +5
 */
import type { StremioSubtitle } from '../stremio/protocol.js';
import { languageMatches, normalizeLanguageTag } from './language.js';

export interface SubtitleQueryContext {
    language?: string;
    season?: number;
    episode?: number;
    releaseName?: string;
    /** When true, hearing-impaired tracks score lower instead of higher. */
    preferNonHearingImpaired?: boolean;
}

export interface ScoredSubtitle {
    score: number;
    reasons: string[];
    hearingImpaired: boolean;
    langCanonical: string;
}

/** Common hearing-impaired markers in ids/urls/flags. */
const HI_MARKERS = /(^|[^a-z])(hi|sdh|cc|hearing[._ -]?impaired)([^a-z]|$)/i;

export function detectHearingImpaired(sub: StremioSubtitle): boolean {
    if (sub.extra === true || sub._hi === true) return true;
    const haystack = `${sub.id ?? ''} ${sub.url}`;
    return HI_MARKERS.test(haystack);
}

function seasonEpisodeMatch(
    sub: StremioSubtitle,
    season?: number,
    episode?: number
): boolean {
    if (season == null && episode == null) return false;
    const hay = `${sub.id ?? ''} ${sub.url}`;
    if (season != null && episode != null) {
        const re = new RegExp(`[sS]0*${season}[eE]0*${episode}\\b`);
        return re.test(hay);
    }
    return false;
}

export function scoreSubtitleMatch(
    sub: StremioSubtitle,
    ctx: SubtitleQueryContext
): ScoredSubtitle {
    const score = 0;
    const reasons: string[] = [];
    const langCanonical = normalizeLanguageTag(sub.lang);

    let langScore = 0;
    if (ctx.language && langCanonical) {
        if (languageMatches(ctx.language, sub.lang)) {
            const exact = normalizeLanguageTag(ctx.language) === langCanonical;
            langScore = exact ? 50 : 35;
            reasons.push(exact ? 'language:exact' : 'language:primary');
        }
    }

    let seScore = 0;
    if (seasonEpisodeMatch(sub, ctx.season, ctx.episode)) {
        seScore = 25;
        reasons.push('episode:match');
    }

    let releaseScore = 0;
    if (ctx.releaseName) {
        const tokens = ctx.releaseName
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length >= 3);
        const hay = `${sub.id ?? ''} ${sub.url}`.toLowerCase();
        const hits = tokens.filter((t) => hay.includes(t)).length;
        if (tokens.length > 0 && hits === tokens.length) {
            releaseScore = 10;
            reasons.push('release:tokens');
        }
    }

    const hearingImpaired = detectHearingImpaired(sub);
    let hiScore = 0;
    if (hearingImpaired) {
        if (ctx.preferNonHearingImpaired) {
            hiScore = -10;
            reasons.push('accessibility:hi-penalized');
        } else {
            hiScore = 10;
            reasons.push('accessibility:hi');
        }
    }

    const fmt = (sub.format ?? '').toLowerCase();
    const fmtScore =
        /srt|vtt/.test(fmt) || /\.(srt|vtt)(\?|$)/i.test(sub.url) ? 5 : 0;
    if (fmtScore > 0) reasons.push('format:native');

    return {
        score: Math.max(
            0,
            score + langScore + seScore + releaseScore + hiScore + fmtScore
        ),
        reasons,
        hearingImpaired,
        langCanonical
    };
}
