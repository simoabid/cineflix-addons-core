import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealDebridResolver } from '../dist/debrid/realdebrid.js';
import { AllDebridResolver } from '../dist/debrid/alldebrid.js';
import { PremiumizeResolver } from '../dist/debrid/premiumize.js';

test('Resolvers expose accurate capability contracts', () => {
    const rd = new RealDebridResolver('dummy-rd-key');
    const ad = new AllDebridResolver('dummy-ad-key');
    const pm = new PremiumizeResolver('dummy-pm-key');

    const rdCaps = rd.getCapabilities();
    assert.equal(rdCaps.supportsFileSelection, true);
    assert.equal(rdCaps.supportsInstantAvailabilityCheck, true);
    assert.equal(rdCaps.supportsUncachedTransfers, true);
    assert.equal(rdCaps.supportsLinkExpiry, false);

    const adCaps = ad.getCapabilities();
    assert.equal(adCaps.supportsFileSelection, true);
    assert.equal(adCaps.supportsInstantAvailabilityCheck, true);
    assert.equal(adCaps.supportsUncachedTransfers, true);
    // AllDebrid does not expose explicit per-link expiry timestamps via /link/unlock API
    assert.equal(adCaps.supportsLinkExpiry, false);

    const pmCaps = pm.getCapabilities();
    assert.equal(pmCaps.supportsInstantAvailabilityCheck, true);
});

test('AllDebridResolver getLinkExpiry parses expiry URL query params safely', () => {
    const ad = new AllDebridResolver('dummy-ad-key');
    assert.equal(ad.getLinkExpiry('https://alldebrid.com/dl/xyz'), undefined);

    const expiresSec = Math.floor(Date.now() / 1000) + 3600;
    const urlWithExp = `https://alldebrid.com/dl/xyz?expires=${expiresSec}`;
    const expDate = ad.getLinkExpiry(urlWithExp);
    assert.ok(expDate instanceof Date);
    assert.equal(Math.floor(expDate.getTime() / 1000), expiresSec);
});

test('Resolvers classify error categories safely', () => {
    const rd = new RealDebridResolver('dummy-key');
    assert.equal(rd.classifyError(new Error('HTTP 401 Unauthorized: bad_token')), 'auth_failure');
    assert.equal(rd.classifyError(new Error('HTTP 429 Too Many Requests')), 'rate_limited');
    assert.equal(rd.classifyError(new Error('ETIMEDOUT connecting to api')), 'network_error');
    assert.equal(rd.classifyError(new Error('HTTP 503 Service Unavailable')), 'provider_down');
    assert.equal(rd.classifyError(new Error('magnet_error: invalid metadata')), 'invalid_torrent');

    const ad = new AllDebridResolver('dummy-key');
    assert.equal(ad.classifyError(new Error('auth_bad_apikey')), 'auth_failure');
    assert.equal(ad.classifyError(new Error('HTTP 429')), 'rate_limited');
    assert.equal(ad.classifyError(new Error('ECONNRESET')), 'network_error');

    const pm = new PremiumizeResolver('dummy-key');
    assert.equal(pm.classifyError(new Error('invalid api key')), 'auth_failure');
    assert.equal(pm.classifyError(new Error('HTTP 500 Server Error')), 'provider_down');
});

test('Resolvers reject invalid infoHash with typed invalid-torrent resolution', async () => {
    const rd = new RealDebridResolver('dummy-key');
    const res = await rd.resolveCached({ infoHash: 'invalid-not-a-hash' });
    assert.equal(res.kind, 'invalid-torrent');
    assert.ok(res.reason.includes('Invalid infoHash format'));

    const ad = new AllDebridResolver('dummy-key');
    const resAd = await ad.resolveCached({ infoHash: '123' });
    assert.equal(resAd.kind, 'invalid-torrent');

    const pm = new PremiumizeResolver('dummy-key');
    const resPm = await pm.resolveCached({ infoHash: '' });
    assert.equal(resPm.kind, 'invalid-torrent');
});
