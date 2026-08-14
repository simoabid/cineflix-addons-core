import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    scoreAndSelectFile,
    parseEpisodeInfo,
    isVideoFile,
    isSampleOrBonusFile
} from '../dist/debrid/fileSelection.js';

test('parseEpisodeInfo accurately identifies various episode patterns', () => {
    // 1. Standard patterns
    assert.deepEqual(parseEpisodeInfo('Breaking.Bad.S05E14.Ozymandias.1080p.mkv'), {
        matched: true,
        season: 5,
        episode: 14,
        matchType: 'standard'
    });
    assert.deepEqual(parseEpisodeInfo('Show.Name.1x02.720p.HDTV.mkv'), {
        matched: true,
        season: 1,
        episode: 2,
        matchType: 'standard'
    });

    // 2. Multi-episode packs
    const multi = parseEpisodeInfo('Game.of.Thrones.S01E01-E04.1080p.mkv');
    assert.equal(multi.matched, true);
    assert.equal(multi.season, 1);
    assert.equal(multi.episode, 1);
    assert.equal(multi.isMultiEpisode, true);
    assert.equal(multi.matchType, 'multi_episode');

    // 3. Anime / Absolute episode numbering
    const anime = parseEpisodeInfo('[Erai-raws] Frieren - 12 [1080p][Multiple Subtitle].mkv');
    assert.equal(anime.matched, true);
    assert.equal(anime.season, 1);
    assert.equal(anime.episode, 12);
    assert.equal(anime.isAbsoluteEpisode, true);
    assert.equal(anime.matchType, 'anime_absolute');

    // 4. Date-based show
    const dateBased = parseEpisodeInfo('Daily.Show.2024.08.14.720p.mkv');
    assert.equal(dateBased.matched, true);
    assert.equal(dateBased.season, 2024);
    assert.equal(dateBased.episode, 814);
    assert.equal(dateBased.matchType, 'date_based');
});

test('isVideoFile and isSampleOrBonusFile filters', () => {
    assert.equal(isVideoFile('movie.mkv'), true);
    assert.equal(isVideoFile('video.mp4'), true);
    assert.equal(isVideoFile('stream.webm'), true);
    assert.equal(isVideoFile('readme.txt'), false);
    assert.equal(isVideoFile('subtitle.srt'), false);
    assert.equal(isVideoFile('info.nfo'), false);

    assert.equal(isSampleOrBonusFile('movie-sample.mkv'), true);
    assert.equal(isSampleOrBonusFile('trailer_1080p.mp4'), true);
    assert.equal(isSampleOrBonusFile('featurette_vfx.mp4'), true);
    assert.equal(isSampleOrBonusFile('bonus_disc.mkv'), true);
    assert.equal(isSampleOrBonusFile('behind the scenes.mp4'), true);
    assert.equal(isSampleOrBonusFile('main_feature.mkv'), false);
});

test('scoreAndSelectFile respects explicit fileIdx first if it is a video', () => {
    const files = [
        { name: 'video1.mkv', size: 1000000 },
        { name: 'video2.mp4', size: 2000000 },
        { name: 'video3.webm', size: 3000000 }
    ];
    const selection = scoreAndSelectFile(files, { fileIdx: 1 });
    assert.equal(selection.index, 1);
    assert.equal(selection.name, 'video2.mp4');
    assert.equal(selection.matchReason, 'explicit_file_index');
    assert.equal(selection.confidence, 1.0);
});

test('scoreAndSelectFile returns -1 when explicit fileIdx is non-video or no video exists in torrent', () => {
    // 1. Explicit file index is a non-video
    const files1 = [
        { name: 'info.nfo', size: 1024 },
        { name: 'movie.mkv', size: 2000000000 }
    ];
    const selExplicitNonVideo = scoreAndSelectFile(files1, { fileIdx: 0 });
    assert.equal(selExplicitNonVideo.index, -1);
    assert.equal(selExplicitNonVideo.matchReason, 'explicit_index_not_video');

    // 2. Torrent contains only non-video files (.txt, .nfo, .jpg)
    const nonVideoOnly = [
        { name: 'instructions.txt', size: 2048 },
        { name: 'metadata.nfo', size: 1024 },
        { name: 'poster.jpg', size: 500000 }
    ];
    const selNoVideo = scoreAndSelectFile(nonVideoOnly);
    assert.equal(selNoVideo.index, -1);
    assert.equal(selNoVideo.matchReason, 'no_video_files_found');
    assert.equal(selNoVideo.confidence, 0);
});

test('scoreAndSelectFile picks exact episode over larger files', () => {
    const files = [
        { name: 'Show.S01E01.1080p.mkv', size: 1500000000 },
        { name: 'Show.S01E02.1080p.mkv', size: 1400000000 },
        { name: 'Show.S01E03.1080p.mkv', size: 1600000000 },
        { name: 'Show.S01.Bonus.Feature.1080p.mkv', size: 2000000000 },
        { name: 'Show.S01.Sample.mkv', size: 50000000 }
    ];

    const selection = scoreAndSelectFile(files, { season: 1, episode: 2 });
    assert.equal(selection.index, 1);
    assert.equal(selection.name, 'Show.S01E02.1080p.mkv');
    assert.equal(selection.matchReason, 'exact_season_episode_match');
    assert.ok(selection.confidence >= 0.9);
});

test('scoreAndSelectFile matches multi-episode pack correctly', () => {
    const files = [
        { name: 'Show.S01E01-E03.1080p.mkv', size: 3000000000 },
        { name: 'Show.S01E04-E06.1080p.mkv', size: 3000000000 }
    ];

    const selection = scoreAndSelectFile(files, { season: 1, episode: 2 });
    assert.equal(selection.index, 0);
    assert.equal(selection.name, 'Show.S01E01-E03.1080p.mkv');

    const selection2 = scoreAndSelectFile(files, { season: 1, episode: 5 });
    assert.equal(selection2.index, 1);
    assert.equal(selection2.name, 'Show.S01E04-E06.1080p.mkv');
});

test('scoreAndSelectFile matches anime absolute numbering for season 1', () => {
    const files = [
        { name: '[SubGroup] Anime - 01 [1080p].mkv', size: 800000000 },
        { name: '[SubGroup] Anime - 02 [1080p].mkv', size: 820000000 },
        { name: '[SubGroup] Anime - 03 [1080p].mkv', size: 810000000 }
    ];

    const selection = scoreAndSelectFile(files, { season: 1, episode: 2 });
    assert.equal(selection.index, 1);
    assert.equal(selection.name, '[SubGroup] Anime - 02 [1080p].mkv');
});

test('scoreAndSelectFile picks largest video file for movie requests and penalizes samples', () => {
    const files = [
        { name: 'sample.mkv', size: 80000000 },
        { name: 'movie.1080p.mkv', size: 8500000000 },
        { name: 'movie.720p.mkv', size: 4200000000 },
        { name: 'featurette.mkv', size: 500000000 },
        { name: 'info.nfo', size: 1024 }
    ];

    const selection = scoreAndSelectFile(files);
    assert.equal(selection.index, 1);
    assert.equal(selection.name, 'movie.1080p.mkv');
    assert.ok(selection.confidence >= 0.75);
    assert.ok(selection.candidates.length > 0);
});
