/**
 * Subtitle experience unit tests (Phase 12 §15.2).
 *
 * Covers BCP 47 language canonicalization/matching, explainable match
 * scoring, ranking/dedup/accessibility preferences, and the fallback
 * template guard rails (no network — template failures resolve to null
 * before any fetch is attempted).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeLanguageTag,
    languageMatches,
    describeLanguage
} from '../dist/subtitles/language.js';
import {
    detectHearingImpaired,
    scoreSubtitleMatch
} from '../dist/subtitles/matching.js';
import { rankSubtitles } from '../dist/subtitles/index.js';
import { fetchFallbackSubtitles } from '../dist/subtitles/fallback.js';

// ── Language canonicalization ────────────────────────────────────────────────

describe('normalizeLanguageTag', () => {
    test('canonicalizes case and separators', () => {
        assert.equal(normalizeLanguageTag('EN-us'), 'en-US');
        assert.equal(normalizeLanguageTag('pt_br'), 'pt-BR');
        assert.equal(normalizeLanguageTag('ZH-hans-CN'), 'zh-Hans-CN');
        assert.equal(normalizeLanguageTag(' en '), 'en');
    });

    test('maps ISO 639-2/B and -T codes to 639-1', () => {
        assert.equal(normalizeLanguageTag('ger'), 'de');
        assert.equal(normalizeLanguageTag('deu'), 'de');
        assert.equal(normalizeLanguageTag('fra'), 'fr');
        assert.equal(normalizeLanguageTag('zho'), 'zh');
    });

    test('maps common language names', () => {
        assert.equal(normalizeLanguageTag('English'), 'en');
        assert.equal(normalizeLanguageTag('portuguese (brazil)'), 'pt-BR');
    });

    test('strips decorations', () => {
        assert.equal(normalizeLanguageTag('[en]'), 'en');
        assert.equal(normalizeLanguageTag('subtitles: en'), 'en');
    });

    test('returns empty for unusable input', () => {
        assert.equal(normalizeLanguageTag(undefined), '');
        assert.equal(normalizeLanguageTag(''), '');
        assert.equal(normalizeLanguageTag('   '), '');
        assert.equal(normalizeLanguageTag('???'), '');
    });

    test('preserves unknown-but-valid primaries', () => {
        assert.equal(normalizeLanguageTag('xyz'), 'xyz');
    });
});

describe('languageMatches', () => {
    test('exact canonical match', () => {
        assert.equal(languageMatches('en', 'en'), true);
        assert.equal(languageMatches('EN-US', 'en-US'), true);
    });

    test('prefix match in both directions', () => {
        // Request "en" matches "en-US" and vice versa (primary fallback).
        assert.equal(languageMatches('en', 'en-US'), true);
        assert.equal(languageMatches('pt-BR', 'pt'), true);
    });

    test('different primaries never match', () => {
        assert.equal(languageMatches('en', 'fr'), false);
        assert.equal(languageMatches('de', 'en-US'), false);
    });

    test('equivalent tags across conventions match', () => {
        assert.equal(languageMatches('ger', 'de'), true);
        assert.equal(languageMatches('german', 'de-DE'), true);
    });

    test('empty inputs never match', () => {
        assert.equal(languageMatches('', 'en'), false);
        assert.equal(languageMatches('en', ''), false);
    });
});

describe('describeLanguage', () => {
    test('human labels for known codes', () => {
        assert.equal(describeLanguage('en'), 'English');
        assert.equal(describeLanguage('fr'), 'French');
    });

    test('region suffix is appended', () => {
        assert.equal(describeLanguage('en-US'), 'English (US)');
    });

    test('unknown codes fall back to uppercase', () => {
        assert.equal(describeLanguage('xyz'), 'XYZ');
        assert.equal(describeLanguage(''), 'Unknown');
    });
});

// ── Hearing-impaired detection + scoring ─────────────────────────────────────

describe('detectHearingImpaired', () => {
    test('detects SDH/CC markers in urls and ids', () => {
        assert.equal(
            detectHearingImpaired({
                url: 'https://x/s1e1.sdh.srt',
                lang: 'en'
            }),
            true
        );
        assert.equal(
            detectHearingImpaired({
                url: 'https://x/a.srt',
                lang: 'en',
                id: 'cc-track-1'
            }),
            true
        );
        assert.equal(
            detectHearingImpaired({
                url: 'https://x/a.srt',
                lang: 'en',
                id: 'hearing-impaired'
            }),
            true
        );
    });

    test('plain tracks are not hearing impaired', () => {
        assert.equal(
            detectHearingImpaired({
                url: 'https://x/movie.en.srt',
                lang: 'en'
            }),
            false
        );
    });
});

describe('scoreSubtitleMatch', () => {
    test('exact language + episode + format stacks', () => {
        const s = scoreSubtitleMatch(
            {
                url: 'https://x/show.s01e02.en.srt',
                lang: 'en'
            },
            { language: 'en', season: 1, episode: 2 }
        );
        assert.equal(s.score, 50 + 25 + 5);
        assert.deepEqual(s.reasons, [
            'language:exact',
            'episode:match',
            'format:native'
        ]);
    });

    test('primary-language match scores lower than exact', () => {
        const exact = scoreSubtitleMatch(
            { url: 'https://x/a', lang: 'en-US' },
            { language: 'en-US' }
        );
        const primary = scoreSubtitleMatch(
            { url: 'https://x/a', lang: 'en' },
            { language: 'en-US' }
        );
        assert.equal(exact.score, 50);
        assert.equal(primary.score, 35);
    });

    test('hearing-impaired boosts by default and penalizes when avoided', () => {
        const sub = { url: 'https://x/show.sdh.srt', lang: 'en' };
        const boosted = scoreSubtitleMatch(sub, { language: 'en' });
        const penalized = scoreSubtitleMatch(sub, {
            language: 'en',
            preferNonHearingImpaired: true
        });
        assert.equal(boosted.reasons.includes('accessibility:hi'), true);
        assert.equal(
            penalized.reasons.includes('accessibility:hi-penalized'),
            true
        );
        assert.equal(penalized.score, boosted.score - 20);
    });

    test('release-name token hits add confidence', () => {
        const s = scoreSubtitleMatch(
            {
                url: 'https://x/Example.Show.2023.1080p.srt',
                lang: 'en'
            },
            { releaseName: 'Example Show 2023' }
        );
        assert.equal(s.reasons.includes('release:tokens'), true);
    });
});

// ── Ranking ──────────────────────────────────────────────────────────────────

function entry(sub, providerId = 'addon:test', origin = 'addon') {
    return { sub, providerId, origin };
}

describe('rankSubtitles', () => {
    test('sorts by score descending and dedups by url', () => {
        const ranked = rankSubtitles(
            [
                entry({ url: 'https://x/a.srt', lang: 'fr' }),
                entry({ url: 'https://x/b.srt', lang: 'en' }),
                entry({ url: 'https://x/a.srt', lang: 'en' }) // dup url
            ],
            { language: 'en' }
        );
        assert.equal(ranked.length, 2);
        assert.equal(ranked[0].collected.sub.url, 'https://x/b.srt');
        assert.equal(ranked[0].score, 55); // 50 language + 5 format
        // Dedup keeps the highest-scored (lang en) occurrence.
        assert.equal(ranked[1].langCanonical, 'en');
    });

    test('accessibility avoid excludes hearing-impaired tracks', () => {
        const ranked = rankSubtitles(
            [
                entry({ url: 'https://x/plain.srt', lang: 'en' }),
                entry({ url: 'https://x/sdh.srt', lang: 'en' })
            ],
            {},
            { hearingImpaired: 'avoid' }
        );
        assert.equal(ranked.length, 1);
        assert.equal(ranked[0].collected.sub.url, 'https://x/plain.srt');
    });

    test('accessibility only keeps exclusively hearing-impaired tracks', () => {
        const ranked = rankSubtitles(
            [
                entry({ url: 'https://x/plain.srt', lang: 'en' }),
                entry({ url: 'https://x/sdh.srt', lang: 'en' })
            ],
            {},
            { hearingImpaired: 'only' }
        );
        assert.equal(ranked.length, 1);
        assert.equal(ranked[0].collected.sub.url, 'https://x/sdh.srt');
        assert.equal(ranked[0].hearingImpaired, true);
    });

    test('language preference drops non-matching when matches exist', () => {
        const ranked = rankSubtitles(
            [
                entry({ url: 'https://x/en.srt', lang: 'EN-US' }),
                entry({ url: 'https://x/fr.srt', lang: 'fr' })
            ],
            { language: 'en' }
        );
        assert.equal(ranked.length, 1);
        assert.equal(ranked[0].collected.sub.url, 'https://x/en.srt');
    });

    test('language preference degrades gracefully when nothing matches', () => {
        const ranked = rankSubtitles(
            [
                entry({ url: 'https://x/fr.srt', lang: 'fr' }),
                entry({ url: 'https://x/de.srt', lang: 'de' })
            ],
            { language: 'ja' }
        );
        assert.equal(ranked.length, 2);
    });

    test('maxResults caps output', () => {
        const ranked = rankSubtitles(
            ['1', '2', '3'].map((n) =>
                entry({ url: `https://x/${n}.srt`, lang: 'en' })
            ),
            {},
            { maxResults: 2 }
        );
        assert.equal(ranked.length, 2);
    });

    test('non-http urls are dropped', () => {
        const ranked = rankSubtitles([
            entry({ url: 'magnet:?xt=1', lang: 'en' }),
            entry({ url: 'https://x/ok.srt', lang: 'en' })
        ]);
        assert.equal(ranked.length, 1);
        assert.equal(ranked[0].collected.sub.url, 'https://x/ok.srt');
    });
});

// ── Fallback template guard rails (no network) ───────────────────────────────

describe('fetchFallbackSubtitles', () => {
    test('returns null when a required placeholder has no value', async () => {
        const res = await fetchFallbackSubtitles(
            { template: 'https://fb.example/s?imdb={imdbId}' },
            {}
        );
        assert.equal(res, null);
    });

    test('returns null for unknown leftover placeholders', async () => {
        const res = await fetchFallbackSubtitles(
            { template: 'https://fb.example/s?weird={unknown}' },
            {}
        );
        assert.equal(res, null);
    });

    test('returns null for a non-url template', async () => {
        const res = await fetchFallbackSubtitles(
            { template: 'not a url {imdbId}' },
            { imdbId: 'tt123' }
        );
        assert.equal(res, null);
    });

    test('season/episode placeholders require their values', async () => {
        const res = await fetchFallbackSubtitles(
            { template: 'https://fb.example/s?imdb={imdbId}&s={season}' },
            { imdbId: 'tt123' } // no season
        );
        assert.equal(res, null);
    });
});
