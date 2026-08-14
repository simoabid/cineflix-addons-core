/**
 * Multi-factor explainable torrent file selection engine.
 *
 * Implements priority and scoring heuristics to select the correct video file from
 * a multi-file torrent for a given movie or TV episode request.
 */
import type { FileSelectionResult, FileCandidate } from './types.js';

export interface FileInfo {
    name: string;
    size: number;
    index?: number;
}

export interface FileSelectionOptions {
    fileIdx?: number;
    season?: number;
    episode?: number;
    title?: string;
}

const VIDEO_EXTENSIONS: Record<string, number> = {
    mkv: 50,
    mp4: 45,
    webm: 40,
    m4v: 35,
    ts: 30,
    m2ts: 25,
    avi: 20,
    mov: 15,
    flv: 10,
    wmv: 10,
    mpg: 5,
    mpeg: 5
};

const SAMPLE_OR_BONUS_REGEX =
    /(?:^|[\s._\-\[/])(sample|trailer|featurette|bonus|extras?|behind[._ -]?the[._ -]?scenes|deleted[._ -]?scenes?|teaser)(?:$|[\s._\-\]\d/])/i;

const NON_VIDEO_EXTENSIONS = new Set([
    'nfo',
    'txt',
    'jpg',
    'jpeg',
    'png',
    'gif',
    'srt',
    'sub',
    'idx',
    'ass',
    'vtt',
    'cue',
    'sfv',
    'url',
    'exe'
]);

export function getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1 || lastDot === filename.length - 1) return '';
    return filename.slice(lastDot + 1).toLowerCase();
}

export function isVideoFile(filename: string): boolean {
    const ext = getFileExtension(filename);
    return Object.prototype.hasOwnProperty.call(VIDEO_EXTENSIONS, ext);
}

export function isSampleOrBonusFile(filename: string): boolean {
    return SAMPLE_OR_BONUS_REGEX.test(filename);
}

export interface EpisodeMatchResult {
    matched: boolean;
    season?: number;
    episode?: number;
    isMultiEpisode?: boolean;
    isAbsoluteEpisode?: boolean;
    matchType?: 'standard' | 'multi_episode' | 'anime_absolute' | 'date_based';
}

export function parseEpisodeInfo(filename: string): EpisodeMatchResult {
    const name = filename.replace(/\.[^.]+$/, ''); // strip extension

    // 1. Multi-episode pack: S01E01-E04, S01E01-04, 1x01-04
    const multiPattern =
        /[sS]0*(\d+)[ ._-]*[eE]0*(\d+)(?:[-_~eE]+0*(\d+))|\b0*(\d+)x0*(\d+)-0*(\d+)\b/i;
    const multiMatch = name.match(multiPattern);
    if (multiMatch) {
        if (multiMatch[1] && multiMatch[2] && multiMatch[3]) {
            return {
                matched: true,
                season: parseInt(multiMatch[1], 10),
                episode: parseInt(multiMatch[2], 10),
                isMultiEpisode: true,
                matchType: 'multi_episode'
            };
        }
        if (multiMatch[4] && multiMatch[5] && multiMatch[6]) {
            return {
                matched: true,
                season: parseInt(multiMatch[4], 10),
                episode: parseInt(multiMatch[5], 10),
                isMultiEpisode: true,
                matchType: 'multi_episode'
            };
        }
    }

    // 2. Standard SxxExx or 1x02
    const stdPattern =
        /[sS]0*(\d+)[ ._/-]*[eE]0*(\d+)\b|\b0*(\d+)x0*(\d+)\b|\b[sS]eason\s*0*(\d+)\s*[eE]pisode\s*0*(\d+)\b/i;
    const stdMatch = name.match(stdPattern);
    if (stdMatch) {
        const season = parseInt(stdMatch[1] || stdMatch[3] || stdMatch[5], 10);
        const episode = parseInt(stdMatch[2] || stdMatch[4] || stdMatch[6], 10);
        return {
            matched: true,
            season,
            episode,
            matchType: 'standard'
        };
    }

    // 3. Anime / Absolute episode: [SubGroup] Show - 04 [1080p] or Episode 04 or EP04
    const animePattern =
        /(?:\[[^\]]+\]|\b[A-Za-z0-9_.-]+)\s*-\s*0*(\d+)(?:\s*\[|\s*\.|\s*$|\s*v\d|\s*\()|\b(?:ep|episode)\s*0*(\d+)\b/i;
    const animeMatch = name.match(animePattern);
    if (animeMatch) {
        const ep = parseInt(animeMatch[1] || animeMatch[2], 10);
        return {
            matched: true,
            season: 1,
            episode: ep,
            isAbsoluteEpisode: true,
            matchType: 'anime_absolute'
        };
    }

    // 4. Date-based: 2026.08.14 or 2026-08-14
    const datePattern =
        /\b(19\d\d|20\d\d)[ ._-](0[1-9]|1[0-2])[ ._-](0[1-9]|[12]\d|3[01])\b/;
    const dateMatch = name.match(datePattern);
    if (dateMatch) {
        return {
            matched: true,
            season: parseInt(dateMatch[1], 10),
            episode: parseInt(`${dateMatch[2]}${dateMatch[3]}`, 10),
            matchType: 'date_based'
        };
    }

    return { matched: false };
}

/** Check if a filename matches a multi-episode range (e.g. S01E01-E04 for episode 3). */
function matchesMultiEpisodeRange(
    filename: string,
    targetSeason: number,
    targetEpisode: number
): boolean {
    const name = filename.replace(/\.[^.]+$/, '');
    const m =
        name.match(/[sS]0*(\d+)[ ._-]*[eE]0*(\d+)(?:[-_~eE]+0*(\d+))/i) ||
        name.match(/\b0*(\d+)x0*(\d+)-0*(\d+)\b/i);
    if (!m) return false;
    const season = parseInt(m[1], 10);
    const startEp = parseInt(m[2], 10);
    const endEp = parseInt(m[3], 10);
    return (
        season === targetSeason &&
        targetEpisode >= startEp &&
        targetEpisode <= endEp
    );
}

/**
 * Score each file candidate and pick the best matching index with explainability.
 */
export function scoreAndSelectFile(
    files: FileInfo[],
    opts: FileSelectionOptions = {}
): FileSelectionResult {
    if (files.length === 0) {
        return {
            index: -1,
            name: '',
            size: 0,
            matchReason: 'no_files_available',
            confidence: 0,
            candidates: []
        };
    }

    // 1. Explicit file index takes unconditional precedence if valid and is a video
    if (
        opts.fileIdx != null &&
        opts.fileIdx >= 0 &&
        opts.fileIdx < files.length
    ) {
        const file = files[opts.fileIdx];
        if (
            isVideoFile(file.name) &&
            !NON_VIDEO_EXTENSIONS.has(getFileExtension(file.name))
        ) {
            return {
                index: opts.fileIdx,
                name: file.name,
                size: file.size,
                matchReason: 'explicit_file_index',
                confidence: 1.0,
                candidates: [
                    {
                        index: opts.fileIdx,
                        name: file.name,
                        size: file.size,
                        score: 10000,
                        reason: 'explicit_file_index'
                    }
                ]
            };
        }
        return {
            index: -1,
            name: file.name,
            size: file.size,
            matchReason: 'explicit_index_not_video',
            confidence: 0,
            candidates: []
        };
    }

    const maxSize = Math.max(...files.map((f) => f.size), 1);
    const candidates: FileCandidate[] = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = getFileExtension(file.name);
        let score = 0;
        const reasons: string[] = [];

        // Extension score
        if (NON_VIDEO_EXTENSIONS.has(ext)) {
            score -= 10000;
            reasons.push('non_video_extension');
        } else if (VIDEO_EXTENSIONS[ext]) {
            score += VIDEO_EXTENSIONS[ext];
            reasons.push(`video_${ext}`);
        } else {
            score -= 500;
            reasons.push('unknown_extension');
        }

        // Penalty for sample / extras / trailers
        if (isSampleOrBonusFile(file.name)) {
            score -= 5000;
            reasons.push('sample_or_bonus_penalty');
        }

        // Relative size score (up to 50 points)
        const sizeRatio = file.size / maxSize;
        score += Math.round(sizeRatio * 50);

        // Tiny file penalty for video files (< 30 MB)
        if (file.size < 30 * 1024 * 1024 && file.size > 0) {
            score -= 300;
            reasons.push('tiny_file_penalty');
        }

        // Episode matching
        if (opts.season != null && opts.episode != null) {
            const parsed = parseEpisodeInfo(file.name);
            if (parsed.matched) {
                if (
                    parsed.season === opts.season &&
                    parsed.episode === opts.episode
                ) {
                    score += 2000;
                    reasons.push(
                        `exact_episode_match_s${opts.season}e${opts.episode}`
                    );
                } else if (
                    parsed.isMultiEpisode &&
                    matchesMultiEpisodeRange(
                        file.name,
                        opts.season,
                        opts.episode
                    )
                ) {
                    score += 1800;
                    reasons.push(
                        `multi_episode_range_match_s${opts.season}e${opts.episode}`
                    );
                } else if (
                    parsed.isAbsoluteEpisode &&
                    (opts.season === 1 || opts.season === 0) &&
                    parsed.episode === opts.episode
                ) {
                    score += 1500;
                    reasons.push(
                        `anime_absolute_episode_match_e${opts.episode}`
                    );
                } else {
                    // Mismatched episode in the same pack
                    score -= 4000;
                    reasons.push(
                        `mismatched_episode_s${parsed.season}e${parsed.episode}`
                    );
                }
            } else {
                // TV request but file has no identifiable episode info
                score -= 100;
                reasons.push('no_episode_tag');
            }
        }

        candidates.push({
            index: i,
            name: file.name,
            size: file.size,
            score,
            reason: reasons.join('; ')
        });
    }

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score);

    const winner = candidates[0];
    if (
        !winner ||
        !isVideoFile(winner.name) ||
        NON_VIDEO_EXTENSIONS.has(getFileExtension(winner.name))
    ) {
        return {
            index: -1,
            name: '',
            size: 0,
            matchReason: 'no_video_files_found',
            confidence: 0,
            candidates: []
        };
    }

    const topScore = winner.score;

    let confidence = 0.5;
    let matchReason = 'largest_video_fallback';

    if (topScore > 1500) {
        confidence = 0.95;
        matchReason = 'exact_season_episode_match';
    } else if (topScore > 1000) {
        confidence = 0.85;
        matchReason = 'multi_episode_or_anime_match';
    } else if (topScore > 0) {
        confidence = 0.75;
        matchReason = 'best_scoring_video';
    } else {
        confidence = 0.3;
        matchReason = 'fallback_low_confidence';
    }

    return {
        index: winner.index,
        name: winner.name,
        size: winner.size,
        matchReason,
        confidence,
        candidates: candidates.slice(0, 5)
    };
}
