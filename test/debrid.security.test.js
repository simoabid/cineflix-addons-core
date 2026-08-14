import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTorrentStreams } from '../dist/debrid/torrentSources.js';
import { debridService } from '../dist/debrid/service.js';

test('resolveTorrentStreams wraps raw debrid URLs in secure playback grants', async () => {
    // Mock debrid resolver with fixed direct download URL
    const mockResolver = {
        id: 'realdebrid',
        name: 'Real-Debrid',
        getCapabilities: () => ({
            supportsInstantAvailabilityCheck: true,
            supportsFileSelection: true,
            supportsUncachedTransfers: false,
            supportsLinkExpiry: false
        }),
        checkCredentials: async () => ({ ok: true, user: 'testuser' }),
        check: async () => ({ ok: true, user: 'testuser' }),
        resolveCached: async (input) => ({
            kind: 'resolved',
            url: 'https://download.real-debrid.com/d/RAW_SECRET_TOKEN/video.mp4',
            selectedFile: {
                index: 0,
                name: 'video.mp4',
                size: 1500000000,
                matchReason: 'exact_season_episode_match',
                confidence: 0.95
            },
            cached: true
        }),
        resolve: async () => 'https://download.real-debrid.com/d/RAW_SECRET_TOKEN/video.mp4',
        cleanup: async () => {},
        classifyError: () => 'unknown'
    };

    // Temporarily inject mock resolver into debridService
    debridService.configure({ provider: 'realdebrid', apiKey: 'test-key' });
    debridService['resolver'] = mockResolver;

    const mockProxyFn = async (rawUrl) => {
        // Simulates PlaybackGrantService creating an opaque signed proxy token
        assert.ok(rawUrl.includes('RAW_SECRET_TOKEN'));
        return 'https://cinemeta.cineflix.app/v1/proxy/grant/opaque-grant-token-xyz';
    };

    const streams = [
        {
            name: 'Torrentio [RD+]',
            title: 'Movie 1080p\n💾 1.5 GB',
            infoHash: '0123456789abcdef0123456789abcdef01234567',
            fileIdx: 0
        }
    ];

    const sources = await resolveTorrentStreams(
        streams,
        'addon:torrentio',
        'Torrentio',
        mockProxyFn,
        { title: 'Test Movie' }
    );

    assert.equal(sources.length, 1);
    const source = sources[0];

    // Client receives ONLY the opaque grant URL, NEVER the raw secret upstream token
    assert.equal(source.url, 'https://cinemeta.cineflix.app/v1/proxy/grant/opaque-grant-token-xyz');
    assert.equal(source.provider.id, 'addon:torrentio');
    assert.equal(source.provider.name, 'Torrentio (debrid)');

    // Reset service
    debridService.configure({ provider: 'none', apiKey: '' });
});
