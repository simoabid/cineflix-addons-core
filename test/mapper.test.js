import test from 'node:test';
import assert from 'node:assert/strict';
import {
    inferSourceType,
    inferQuality,
    isPlayableStream,
    inferTypeFromUrl,
    inferSubtitleFormat,
    mapStreamsToSources,
    mapSubtitles
} from '../dist/stremio/mapper.js';

const proxy = (u, h) =>
    'http://pub/v1/proxy?data=' + encodeURIComponent(JSON.stringify({ url: u, headers: h }));

test('inferTypeFromUrl', () => {
    assert.equal(inferTypeFromUrl('https://x/a.m3u8'), 'hls');
    assert.equal(inferTypeFromUrl('https://x/a.mpd'), 'dash');
    assert.equal(inferTypeFromUrl('https://x/a.mp4'), 'mp4');
    assert.equal(inferTypeFromUrl('https://x/a.mkv'), 'mkv');
    assert.equal(inferTypeFromUrl('https://x/a.webm'), 'webm');
    assert.equal(inferTypeFromUrl('https://x/unknown'), null);
});

test('inferSourceType falls back via size hint then hls', () => {
    assert.equal(inferSourceType({ url: 'https://x/a.m3u8' }), 'hls');
    assert.equal(inferSourceType({ url: 'https://x/f', title: '2.1 GB' }), 'mp4');
    assert.equal(inferSourceType({ url: 'https://x/f' }), 'hls');
});

test('inferQuality reads resolution from text', () => {
    assert.equal(inferQuality({ name: 'Movie 1080p WEB' }), '1080p');
    assert.equal(inferQuality({ title: '4K UHD' }), '2160p');
    assert.equal(inferQuality({ title: 'nothing here' }), 'Auto');
});

test('isPlayableStream requires http(s) url', () => {
    assert.equal(isPlayableStream({ url: 'https://x/a.mp4' }), true);
    assert.equal(isPlayableStream({ url: 'http://x/a.mp4' }), true);
    assert.equal(isPlayableStream({ infoHash: 'abc' }), false);
    assert.equal(isPlayableStream({ externalUrl: 'https://x' }), false);
});

test('mapStreamsToSources wraps url + preserves proxy headers, skips torrents', () => {
    const streams = [
        {
            name: 'A 1080p',
            url: 'https://cdn/a/master.m3u8',
            behaviorHints: { proxyHeaders: { request: { Referer: 'https://ex' } } }
        },
        { name: 'B', title: '8 GB', url: 'https://cdn/b/file.mkv' },
        { name: 'torrent', infoHash: 'abc' }
    ];
    const sources = mapStreamsToSources(streams, 'addon:t', 'T', proxy);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].type, 'hls');
    assert.equal(sources[0].quality, '1080p');
    assert.ok(sources[0].url.startsWith('http://pub/v1/proxy'));
    assert.ok(decodeURIComponent(sources[0].url).includes('Referer'));
    assert.equal(sources[1].type, 'mkv');
    assert.equal(sources[0].provider.id, 'addon:t');
});

test('inferSubtitleFormat', () => {
    assert.equal(inferSubtitleFormat('https://x/a.srt'), 'srt');
    assert.equal(inferSubtitleFormat('https://x/a', 'vtt'), 'vtt');
    assert.equal(inferSubtitleFormat('https://x/a.ass'), 'ass');
    assert.equal(inferSubtitleFormat('https://x/a'), 'vtt');
});

test('mapSubtitles dedupes and proxies', () => {
    const subs = [
        { url: 'https://x/en.srt', lang: 'eng' },
        { url: 'https://x/en.srt', lang: 'eng' },
        { url: 'ftp://bad', lang: 'ger' }
    ];
    const out = mapSubtitles(subs, proxy);
    assert.equal(out.length, 1);
    assert.equal(out[0].format, 'srt');
    assert.equal(out[0].label, 'eng');
    assert.ok(out[0].url.startsWith('http://pub/v1/proxy'));
});
