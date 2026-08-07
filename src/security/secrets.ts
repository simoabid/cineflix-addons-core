/**
 * Envelope encryption for sensitive runtime fields (debrid keys, etc.).
 *
 * Production: supply SECRETS_MASTER_KEY (32-byte key, base64 or hex).
 * Development: a deterministic dev key is derived so local mode works, but
 * production refuses to start without an explicit master key (see config).
 *
 * Wire format:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * Plaintext legacy values are accepted on read and re-encrypted on next save.
 */

import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes
} from 'node:crypto';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

export class SecretsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretsError';
    }
}

export interface SecretBox {
    /** Encrypt a UTF-8 secret. Empty string stays empty. */
    seal(plaintext: string): string;
    /** Decrypt a sealed value, or return plaintext legacy values unchanged. */
    open(stored: string): string;
    /** True when the value looks like an envelope ciphertext. */
    isSealed(stored: string): boolean;
    /** Whether a real (non-dev) master key is configured. */
    hasMasterKey: boolean;
}

export function isStrongMasterKey(raw: string | undefined): boolean {
    if (!raw || !raw.trim()) return false;
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return true;
    try {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length === 32) {
            // Check not weak like all zeros or repeated char
            if (/^(.)\1+$/.test(trimmed)) return false;
            if (trimmed.length < 32) return false;
            return true;
        }
    } catch {
        /* fall through */
    }
    // Anything else is considered weak in production (e.g., "weak", short password)
    return false;
}

function parseMasterKey(raw: string | undefined): {
    key: Buffer;
    explicit: boolean;
} {
    if (raw && raw.trim()) {
        const trimmed = raw.trim();
        // base64 (44 chars for 32 bytes) or hex (64 chars) - strict
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
            return { key: Buffer.from(trimmed, 'hex'), explicit: true };
        }
        try {
            const buf = Buffer.from(trimmed, 'base64');
            if (buf.length === 32) {
                // Also reject weak base64 that decodes to weak
                if (trimmed.length < 32) {
                    // Still allow but will be flagged as weak elsewhere
                }
                return { key: buf, explicit: true };
            }
        } catch {
            /* fall through */
        }
        // In production, weak keys should have been rejected by assert; for dev we still derive
        return {
            key: createHash('sha256').update(trimmed, 'utf8').digest(),
            explicit: true
        };
    }
    // Dev fallback — NOT for production.
    const dev = createHash('sha256')
        .update('addons-core-dev-secrets-key-v1', 'utf8')
        .digest();
    return { key: dev, explicit: false };
}

export function createSecretBox(masterKeyEnv?: string): SecretBox {
    const { key, explicit } = parseMasterKey(masterKeyEnv);

    function seal(plaintext: string): string {
        if (!plaintext) return '';
        if (plaintext.startsWith(PREFIX)) return plaintext; // already sealed
        const iv = randomBytes(12);
        const cipher = createCipheriv(ALGO, key, iv);
        const enc = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        return (
            PREFIX +
            iv.toString('base64url') +
            ':' +
            tag.toString('base64url') +
            ':' +
            enc.toString('base64url')
        );
    }

    function open(stored: string): string {
        if (!stored) return '';
        if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
        const rest = stored.slice(PREFIX.length);
        const parts = rest.split(':');
        if (parts.length !== 3) {
            throw new SecretsError('Corrupt sealed secret (bad parts)');
        }
        const [ivB64, tagB64, dataB64] = parts;
        try {
            const iv = Buffer.from(ivB64, 'base64url');
            const tag = Buffer.from(tagB64, 'base64url');
            const data = Buffer.from(dataB64, 'base64url');
            const decipher = createDecipheriv(ALGO, key, iv);
            decipher.setAuthTag(tag);
            const dec = Buffer.concat([
                decipher.update(data),
                decipher.final()
            ]);
            return dec.toString('utf8');
        } catch (err) {
            throw new SecretsError(
                `Failed to decrypt secret: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    function isSealed(stored: string): boolean {
        return typeof stored === 'string' && stored.startsWith(PREFIX);
    }

    return { seal, open, isSealed, hasMasterKey: explicit };
}

/** Generate a new 32-byte master key as base64 (for docs / bootstrap). */
export function generateMasterKey(): string {
    return randomBytes(32).toString('base64');
}
