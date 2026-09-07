/**
 * BCP 47 language normalization (Phase 12 §15.2).
 *
 * Subtitle `lang` tags from addons are wildly inconsistent ("en", "EN-US",
 * "eng", "pt-BR", "zh-Hans-CN"). This module canonicalizes tags for
 * comparison and display:
 *   primary subtag   → lower-case letters (2–3 letter ISO 639 or reserved)
 *   script subtag    → Title case (4 letters)
 *   region subtag    → UPPER case (2 letters or 3 digits)
 * Ambiguous two-letter language codes are mapped through ISO-639-2/B and -T
 * equivalences (e.g. "ger"/"deu" → "de").
 */

// Common ISO 639-2/B and -T codes that appear in subtitle feeds.
const ISO639_2_TO_1: Record<string, string> = {
    ger: 'de',
    deu: 'de',
    fre: 'fr',
    fra: 'fr',
    spa: 'es',
    ita: 'it',
    eng: 'en',
    por: 'pt',
    rus: 'ru',
    jpn: 'ja',
    kor: 'ko',
    chi: 'zh',
    zho: 'zh',
    dut: 'nl',
    nld: 'nl',
    swe: 'sv',
    nor: 'no',
    dan: 'da',
    fin: 'fi',
    pol: 'pl',
    cze: 'cs',
    ces: 'cs',
    tur: 'tr',
    ara: 'ar',
    heb: 'he',
    hin: 'hi',
    tha: 'th',
    vie: 'vi',
    ind: 'id',
    ukr: 'uk',
    ron: 'ro',
    rum: 'ro',
    ell: 'el',
    gre: 'el',
    hun: 'hu',
    bul: 'bg',
    srp: 'sr',
    hrv: 'hr'
};

// Names commonly used in subtitle feeds instead of codes.
const NAME_TO_CODE: Record<string, string> = {
    english: 'en',
    arabic: 'ar',
    bulgarian: 'bg',
    chinese: 'zh',
    croatian: 'hr',
    czech: 'cs',
    danish: 'da',
    dutch: 'nl',
    finnish: 'fi',
    french: 'fr',
    german: 'de',
    greek: 'el',
    hebrew: 'he',
    hindi: 'hi',
    hungarian: 'hu',
    indonesian: 'id',
    italian: 'it',
    japanese: 'ja',
    korean: 'ko',
    norwegian: 'no',
    polish: 'pl',
    portuguese: 'pt',
    romanian: 'ro',
    russian: 'ru',
    spanish: 'es',
    swedish: 'sv',
    thai: 'th',
    turkish: 'tr',
    ukrainian: 'uk',
    vietnamese: 'vi'
};

// Region names commonly used in parentheses after a language name.
const REGION_NAME_TO_CODE: Record<string, string> = {
    brazil: 'BR',
    brasil: 'BR',
    portugal: 'PT',
    spain: 'ES',
    france: 'FR',
    germany: 'DE',
    japan: 'JP',
    korea: 'KR',
    china: 'CN',
    taiwan: 'TW',
    hongkong: 'HK',
    mexico: 'MX',
    argentina: 'AR',
    netherlands: 'NL',
    russia: 'RU',
    italy: 'IT',
    uk: 'GB',
    britain: 'GB',
    usa: 'US',
    us: 'US',
    canada: 'CA',
    australia: 'AU'
};

/** Canonicalize a raw language tag; returns '' when nothing usable remains. */
export function normalizeLanguageTag(raw: string | undefined): string {
    if (!raw || typeof raw !== 'string') return '';
    let tag = raw.trim().toLowerCase();
    if (!tag) return '';
    // Parenthesized region hints: "portuguese (brazil)" → pt-BR.
    let regionOverride = '';
    tag = tag.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
        const key = inner
            .trim()
            .toLowerCase()
            .replace(/[^a-z]/g, '');
        if (REGION_NAME_TO_CODE[key]) regionOverride = REGION_NAME_TO_CODE[key];
        return ' ';
    });
    // Bracketed decoration: keep the inner text as a candidate ("[en]" → en)
    // but drop the brackets themselves.
    tag = tag.replace(/[[\]]/g, ' ').trim();
    const segments = tag.split(/[-_ :]+/).flatMap((s) => s.split(/\s+/));
    if (segments.length === 0) return '';

    // Primary subtag: first segment that is a known name, an ISO 639-2 code,
    // or a bare 2–3 letter code. Anything before it is decoration.
    let primary = '';
    let primaryIdx = -1;
    for (let i = 0; i < segments.length; i++) {
        const cand = segments[i].replace(/[^a-z]/g, '');
        if (!cand) continue;
        if (NAME_TO_CODE[cand]) {
            primary = NAME_TO_CODE[cand];
            primaryIdx = i;
            break;
        }
        if (ISO639_2_TO_1[cand]) {
            primary = ISO639_2_TO_1[cand];
            primaryIdx = i;
            break;
        }
        if (/^[a-z]{2,3}$/.test(cand)) {
            primary = cand;
            primaryIdx = i;
            break;
        }
    }
    if (!primary) return '';

    const parts = [primary];
    for (const rawSub of segments.slice(primaryIdx + 1)) {
        const sub = rawSub.replace(/[^a-z0-9]/g, '');
        if (!sub) continue;
        if (sub.length === 4 && /^[a-z]{4}$/.test(sub)) {
            // Script: Title case
            parts.push(sub[0].toUpperCase() + sub.slice(1));
        } else if (sub.length === 2 && /^[a-z]{2}$/.test(sub)) {
            parts.push(sub.toUpperCase());
        } else if (sub.length === 3 && /^\d{3}$/.test(sub)) {
            parts.push(sub);
        }
        // Anything else (extensions, private use) is dropped for display.
    }
    if (regionOverride && parts.length === 1) parts.push(regionOverride);
    return parts.join('-');
}

/**
 * True when a subtitle tag matches the requested language.
 * Exact canonical match, or prefix match (request "en" matches "en-US";
 * request "pt-BR" matches "pt" — primary-language fallback).
 */
export function languageMatches(requested: string, tag: string): boolean {
    const req = normalizeLanguageTag(requested);
    const have = normalizeLanguageTag(tag);
    if (!req || !have) return false;
    if (req === have) return true;
    const reqPrimary = req.split('-')[0];
    const havePrimary = have.split('-')[0];
    if (reqPrimary && havePrimary && reqPrimary === havePrimary) return true;
    return false;
}

/** Human label from a canonical tag: "en-US" → "English (US)" best-effort. */
const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
    Object.entries(NAME_TO_CODE).map(([name, code]) => [code, name])
);

export function describeLanguage(canonicalTag: string): string {
    if (!canonicalTag) return 'Unknown';
    const [primary, region] = canonicalTag.split('-');
    const name = CODE_TO_NAME[primary];
    const base = name
        ? name[0].toUpperCase() + name.slice(1)
        : primary.toUpperCase();
    return region ? `${base} (${region})` : base;
}
