import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSecretBox,
    generateMasterKey,
    SecretsError
} from '../dist/security/secrets.js';

test('generateMasterKey returns 32-byte base64', () => {
    const key = generateMasterKey();
    const buf = Buffer.from(key, 'base64');
    assert.equal(buf.length, 32);
});

test('seal/open round-trips with explicit master key', () => {
    const master = generateMasterKey();
    const box = createSecretBox(master);
    assert.equal(box.hasMasterKey, true);

    const sealed = box.seal('rd-api-key-value');
    assert.ok(sealed.startsWith('enc:v1:'));
    assert.notEqual(sealed, 'rd-api-key-value');
    assert.equal(box.open(sealed), 'rd-api-key-value');
});

test('seal is non-deterministic (random IV)', () => {
    const box = createSecretBox(generateMasterKey());
    const a = box.seal('same-secret');
    const b = box.seal('same-secret');
    assert.notEqual(a, b);
    assert.equal(box.open(a), box.open(b));
});

test('open accepts legacy plaintext and re-seal is idempotent on already-sealed', () => {
    const box = createSecretBox(generateMasterKey());
    assert.equal(box.open('legacy-plaintext-key'), 'legacy-plaintext-key');
    const sealed = box.seal('x');
    assert.equal(box.seal(sealed), sealed);
});

test('empty secret stays empty', () => {
    const box = createSecretBox(generateMasterKey());
    assert.equal(box.seal(''), '');
    assert.equal(box.open(''), '');
});

test('wrong master key fails to decrypt', () => {
    const box1 = createSecretBox(generateMasterKey());
    const box2 = createSecretBox(generateMasterKey());
    const sealed = box1.seal('top-secret');
    assert.throws(() => box2.open(sealed), SecretsError);
});

test('dev fallback key works without explicit master', () => {
    const box = createSecretBox(undefined);
    assert.equal(box.hasMasterKey, false);
    const sealed = box.seal('dev-key');
    assert.equal(box.open(sealed), 'dev-key');
});

test('hex master keys are accepted', () => {
    const hex = 'a'.repeat(64);
    const box = createSecretBox(hex);
    assert.equal(box.hasMasterKey, true);
    assert.equal(box.open(box.seal('hex-ok')), 'hex-ok');
});
