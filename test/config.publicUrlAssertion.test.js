/**
 * PUBLIC_URL grant-origin startup assertion (Phase 10 §13.3).
 *
 * The composition root runs assertGrantPublicUrlOrigin() at boot so that
 * generated playback-grant URLs are guaranteed to use the configured public
 * origin. These tests cover the guard itself via the compiled artifact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createPlaybackGrantStore,
    assertGrantPublicUrlOrigin
} from '../dist/security/index.js';

function makeGrants() {
    // Dev-safe secret; production strength is enforced by config, not here.
    return createPlaybackGrantStore({
        signingSecret: 'unit-test-grant-secret-0123456789abcdef'
    });
}

test('grant proxy URLs build against the configured public origin', async () => {
    const grants = makeGrants();
    await assertGrantPublicUrlOrigin(
        grants,
        'https://addons.example.tld',
        'production',
        'https://addons.example.tld'
    );
});

test('assertion fails when grant URLs build on a different origin', async () => {
    const grants = makeGrants();
    await assert.rejects(
        assertGrantPublicUrlOrigin(
            grants,
            'http://0.0.0.0:3006',
            'production',
            'https://addons.example.tld'
        ),
        /startup assertion failed/
    );
});

test('assertion rejects http PUBLIC_URL in production', async () => {
    const grants = makeGrants();
    await assert.rejects(
        assertGrantPublicUrlOrigin(
            grants,
            'http://addons.example.tld',
            'production',
            'http://addons.example.tld'
        ),
        /must be https in production/
    );
});

test('assertion tolerates http origins in development', async () => {
    const grants = makeGrants();
    await assertGrantPublicUrlOrigin(
        grants,
        'http://127.0.0.1:3006',
        'development',
        undefined
    );
});
