import test from 'node:test';
import assert from 'node:assert/strict';
import {
    tmdbIdValidator,
    seasonEpisodeValidator,
    providerIdValidator,
    jobIdValidator,
    addonsQueryValidator,
    subtitlesQueryValidator,
    jobsQueryValidator,
    auditQueryValidator,
    metricsQueryValidator,
    patchAddonBodyValidator,
    reorderAddonsBodyValidator,
    importUrlBodyValidator,
    importStremioBodyValidator,
    importRepoBodyValidator,
    createJobBodyValidator,
    debridTransferBodyValidator,
    patchDebridBodyValidator
} from '../dist/validation/schemas.js';

test('tmdbIdValidator strictly accepts valid numeric and tt-prefixed IMDb IDs', () => {
    assert.equal(tmdbIdValidator('550').ok, true);
    assert.equal(tmdbIdValidator('tt0137523').ok, true);
    assert.equal(tmdbIdValidator('1234567').ok, true);

    // Strictly reject custom non-standard formats
    assert.equal(tmdbIdValidator('custom_id:123').ok, false);
    assert.equal(tmdbIdValidator('').ok, false);
    assert.equal(tmdbIdValidator('   ').ok, false);
    assert.equal(tmdbIdValidator(123).ok, false);
});

test('seasonEpisodeValidator validates non-negative season (>=0) and positive episode (>=1)', () => {
    assert.equal(seasonEpisodeValidator('1', '5').ok, true);
    assert.equal(seasonEpisodeValidator(0, 1).ok, true);

    // Episode 0 must be rejected (episodes are 1-indexed)
    assert.equal(seasonEpisodeValidator(1, 0).ok, false);
    assert.equal(seasonEpisodeValidator('-1', '5').ok, false);
    assert.equal(seasonEpisodeValidator('abc', '5').ok, false);
    assert.equal(seasonEpisodeValidator('1.5', '5').ok, false);
});

test('providerIdValidator enforces safe character sets and lengths', () => {
    assert.equal(providerIdValidator('addon:torrentio').ok, true);
    assert.equal(providerIdValidator('cinemeta_v2').ok, true);

    assert.equal(providerIdValidator('').ok, false);
    assert.equal(providerIdValidator('bad<script>').ok, false);
    assert.equal(providerIdValidator('a'.repeat(200)).ok, false);
});

test('jobIdValidator validates alphanumeric identifier tokens', () => {
    assert.equal(jobIdValidator('job_12345').ok, true);
    assert.equal(jobIdValidator('job-abc-xyz').ok, true);
    assert.equal(jobIdValidator('').ok, false);
    assert.equal(jobIdValidator('job/with/slashes').ok, false);
});

test('addonsQueryValidator parses and validates search, capability, sort, pagination within plan bounds', () => {
    const valid = addonsQueryValidator({
        page: '2',
        limit: '25',
        search: 'torrentio',
        capability: 'stream',
        health: 'healthy',
        enabled: 'true',
        sort: 'name',
        direction: 'desc'
    });

    assert.equal(valid.ok, true);
    assert.equal(valid.data?.page, 2);
    assert.equal(valid.data?.limit, 25);
    assert.equal(valid.data?.search, 'torrentio');
    assert.equal(valid.data?.capability, 'stream');
    assert.equal(valid.data?.health, 'healthy');
    assert.equal(valid.data?.enabled, true);
    assert.equal(valid.data?.sort, 'name');
    assert.equal(valid.data?.direction, 'desc');

    // Page > 1000 or limit > 200 must be rejected per spec
    const invalid = addonsQueryValidator({
        page: '1001',
        limit: '201',
        capability: 'unsupported_cap',
        sort: 'invalid_sort'
    });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors && invalid.errors.length >= 4);
});

test('subtitlesQueryValidator validates required media IDs and optional params', () => {
    const validTmdb = subtitlesQueryValidator({ tmdbId: '550', language: 'eng' });
    assert.equal(validTmdb.ok, true);
    assert.equal(validTmdb.data?.tmdbId, '550');
    assert.equal(validTmdb.data?.language, 'eng');

    const validImdb = subtitlesQueryValidator({ imdbId: 'tt0137523', season: 1, episode: 2 });
    assert.equal(validImdb.ok, true);
    assert.equal(validImdb.data?.imdbId, 'tt0137523');
    assert.equal(validImdb.data?.season, 1);
    assert.equal(validImdb.data?.episode, 2);

    const missingId = subtitlesQueryValidator({ language: 'eng' });
    assert.equal(missingId.ok, false);
});

test('jobsQueryValidator, auditQueryValidator, and metricsQueryValidator work properly', () => {
    const jobQ = jobsQueryValidator({ page: 1, limit: 50, status: 'running' });
    assert.equal(jobQ.ok, true);
    assert.equal(jobQ.data?.status, 'running');

    const auditQ = auditQueryValidator({ page: 1, limit: 100, outcome: 'success' });
    assert.equal(auditQ.ok, true);
    assert.equal(auditQ.data?.outcome, 'success');

    const metricsQ = metricsQueryValidator({ format: 'json' });
    assert.equal(metricsQ.ok, true);
    assert.equal(metricsQ.data?.format, 'json');

    const badMetricsQ = metricsQueryValidator({ format: 'xml' });
    assert.equal(badMetricsQ.ok, false);
});

test('importUrlBodyValidator blocks SSRF vectors (schemes, localhost, metadata IP)', () => {
    const valid = importUrlBodyValidator({ url: 'https://v3-cinemeta.strem.io/manifest.json' });
    assert.equal(valid.ok, true);

    // SSRF vectors must be rejected by validator
    assert.equal(importUrlBodyValidator({ url: 'javascript:alert(1)' }).ok, false);
    assert.equal(importUrlBodyValidator({ url: 'file:///etc/passwd' }).ok, false);
    assert.equal(importUrlBodyValidator({ url: 'gopher://127.0.0.1:70/' }).ok, false);
    assert.equal(importUrlBodyValidator({ url: 'http://169.254.169.254/latest/meta-data' }).ok, false);
    assert.equal(importUrlBodyValidator({ url: 'http://127.0.0.1:8080/manifest.json' }).ok, false);
    assert.equal(importUrlBodyValidator({ url: 'http://user:pass@example.com/manifest.json' }).ok, false);
});

test('importStremioBodyValidator and importRepoBodyValidator validate inputs including endpoint', () => {
    const stremioAuth = importStremioBodyValidator({ authKey: 'valid_auth_key_123' });
    assert.equal(stremioAuth.ok, true);

    const stremioWithEndpoint = importStremioBodyValidator({
        authKey: 'valid_auth_key_123',
        endpoint: 'https://api.strem.io'
    });
    assert.equal(stremioWithEndpoint.ok, true);
    assert.equal(stremioWithEndpoint.data?.endpoint, 'https://api.strem.io');

    const stremioBadEndpoint = importStremioBodyValidator({
        authKey: 'valid_auth_key_123',
        endpoint: 'javascript:alert(1)'
    });
    assert.equal(stremioBadEndpoint.ok, false);

    const stremioCreds = importStremioBodyValidator({ email: 'user@example.com', password: 'secretpassword' });
    assert.equal(stremioCreds.ok, true);

    const stremioIncomplete = importStremioBodyValidator({ email: 'user@example.com' });
    assert.equal(stremioIncomplete.ok, false);

    const repoValid = importRepoBodyValidator({ url: 'https://repo.example.com/addons.json' });
    assert.equal(repoValid.ok, true);

    const repoBad = importRepoBodyValidator({ url: 'javascript:void(0)' });
    assert.equal(repoBad.ok, false);
});

test('createJobBodyValidator validates payload depth and job fields', () => {
    const valid = createJobBodyValidator({
        type: 'maintenance-sweep',
        payload: { target: 'all' },
        priority: 5
    });
    assert.equal(valid.ok, true);

    const badPriority = createJobBodyValidator({
        type: 'maintenance-sweep',
        priority: 99
    });
    assert.equal(badPriority.ok, false);
});

test('patchAddonBodyValidator validates timeout bounds and rejects unknown keys', () => {
    const valid = patchAddonBodyValidator({ enabled: false, timeoutMs: 8000 });
    assert.equal(valid.ok, true);
    assert.equal(valid.data?.enabled, false);
    assert.equal(valid.data?.timeoutMs, 8000);

    const outOfBounds = patchAddonBodyValidator({ timeoutMs: 50 });
    assert.equal(outOfBounds.ok, false);

    const unknownKeys = patchAddonBodyValidator({ enabled: true, maliciousField: 123 });
    assert.equal(unknownKeys.ok, false);
});

test('reorderAddonsBodyValidator validates order arrays', () => {
    const valid = reorderAddonsBodyValidator({ order: ['addon:a', 'addon:b'] });
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.data?.order, ['addon:a', 'addon:b']);

    const empty = reorderAddonsBodyValidator({ order: [] });
    assert.equal(empty.ok, false);

    const notArray = reorderAddonsBodyValidator({ order: 'addon:a' });
    assert.equal(notArray.ok, false);
});

test('debridTransferBodyValidator validates 40-hex / 32-base32 infoHashes and extracts all optional fields', () => {
    const hex = debridTransferBodyValidator({
        infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
        title: 'Big Buck Bunny 1080p',
        fileIdx: 2,
        sources: ['https://stream.example/video.mkv'],
        maxWaitSec: 120,
        season: 1,
        episode: 5
    });
    assert.equal(hex.ok, true);
    assert.equal(hex.data?.title, 'Big Buck Bunny 1080p');
    assert.equal(hex.data?.fileIdx, 2);
    assert.deepEqual(hex.data?.sources, ['https://stream.example/video.mkv']);
    assert.equal(hex.data?.maxWaitSec, 120);
    assert.equal(hex.data?.season, 1);
    assert.equal(hex.data?.episode, 5);

    // base32 with optional padding
    const base32Padded = debridTransferBodyValidator({ infoHash: 'NBSWY3DPEB3W64TMMQWW2ZJTOQ======' });
    assert.equal(base32Padded.ok, true);

    const b32clean = debridTransferBodyValidator({ infoHash: '2B4QWZ73NJF6KTY5A234567ABCDEFG23' });
    assert.equal(b32clean.ok, true);

    const invalid = debridTransferBodyValidator({ infoHash: 'short-hash' });
    assert.equal(invalid.ok, false);

    // Bad fields validation
    assert.equal(debridTransferBodyValidator({ infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', fileIdx: -1 }).ok, false);
    assert.equal(debridTransferBodyValidator({ infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', maxWaitSec: 0 }).ok, false);
    assert.equal(debridTransferBodyValidator({ infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', maxWaitSec: 1000 }).ok, false);
    assert.equal(debridTransferBodyValidator({ infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', sources: ['javascript:alert(1)'] }).ok, false);
    assert.equal(debridTransferBodyValidator({ infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', sources: [] }).ok, false);
});

test('patchDebridBodyValidator validates rate limit and providers', () => {
    const valid = patchDebridBodyValidator({
        enabled: true,
        apiKey: 'debrid_api_key_123',
        provider: 'realdebrid',
        rateLimitPerMin: 120
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.data?.provider, 'realdebrid');
    assert.equal(valid.data?.rateLimitPerMin, 120);

    const badRate = patchDebridBodyValidator({ rateLimitPerMin: 5 });
    assert.equal(badRate.ok, false);
});
