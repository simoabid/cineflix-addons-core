/**
 * Provider marketplace and policy controls (Phase 12 §15.4).
 *
 * Adds operator-controlled import governance on top of the existing addon
 * admission lifecycle:
 *
 *   - Manifest fingerprints: stable SHA-256 over the canonical manifest JSON,
 *     recorded at install and verified on refresh (drift detection).
 *   - Trust levels: `trusted` (fingerprint allowlist), `known` (manifest-id
 *     allowlist), `unknown`, `blocked` (fingerprint or id denylist).
 *   - Operator allow/deny lists (env-driven, see .env.example §15.4).
 *   - Trust-gated admission: imports below the configured minimum trust level
 *     are installed but stay disabled + `pending` until an operator enables
 *     them — consistent with the phase 1 security admission model.
 *   - Evaluation without installation: `POST /v1/addons/evaluate` lets an
 *     operator preview the classification of a manifest URL (controlled
 *     rollout).
 *
 * Fail-closed: a manifest on the denylist is rejected outright; anything not
 * explicitly trusted is never auto-enabled unless
 * `MARKETPLACE_MIN_TRUST_FOR_ENABLE=unknown` (the permissive default keeps
 * today's behavior for self-hosted single-operator installs).
 */
import crypto from 'node:crypto';
import type { StremioManifest } from '../stremio/protocol.js';
import type { AppConfig } from '../config.js';
import type { AddonValidationFinding } from './types.js';

export type TrustLevel = 'trusted' | 'known' | 'unknown' | 'blocked';

/** Stable, order-independent fingerprint of a manifest document. */
export function manifestFingerprint(manifest: StremioManifest): string {
    const canonical = canonicalJson(manifest);
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        return `{${entries
            .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** Operator-controlled marketplace policy (derived from AppConfig). */
export interface MarketplacePolicy {
    trustedIds: string[];
    trustedFingerprints: string[];
    blockedIds: string[];
    blockedFingerprints: string[];
    /** Minimum trust level that may be auto-enabled at import time. */
    minTrustForEnable: TrustLevel;
    /** When true (default) blocked manifests are rejected outright. */
    enforceDenylist: boolean;
}

export function marketplacePolicyFromConfig(cfg: AppConfig): MarketplacePolicy {
    return {
        trustedIds: cfg.marketplaceTrustedIds,
        trustedFingerprints: cfg.marketplaceTrustedFingerprints,
        blockedIds: cfg.marketplaceBlockedIds,
        blockedFingerprints: cfg.marketplaceBlockedFingerprints,
        minTrustForEnable: cfg.marketplaceMinTrustForEnable,
        enforceDenylist: cfg.marketplaceEnforceDenylist
    };
}

export interface MarketplaceClassification {
    level: TrustLevel;
    /** Human-readable reason for the classification. */
    reason: string;
    fingerprint: string;
    matchedBy?: 'fingerprint' | 'id';
}

/**
 * Classify a manifest against the operator's lists. Precedence:
 * denylist (fingerprint, then id) > trusted fingerprint > trusted id >
 * unknown. Matching is case-insensitive for ids; fingerprints are hex.
 */
export function classifyManifest(
    manifest: StremioManifest,
    policy: MarketplacePolicy
): MarketplaceClassification {
    const fp = manifestFingerprint(manifest);
    const id = String(manifest.id ?? '').toLowerCase();

    if (policy.blockedFingerprints.includes(fp)) {
        return {
            level: 'blocked',
            reason: 'Manifest fingerprint is on the operator denylist',
            fingerprint: fp,
            matchedBy: 'fingerprint'
        };
    }
    if (id && policy.blockedIds.map((s) => s.toLowerCase()).includes(id)) {
        return {
            level: 'blocked',
            reason: `Manifest id "${id}" is on the operator denylist`,
            fingerprint: fp,
            matchedBy: 'id'
        };
    }
    if (policy.trustedFingerprints.includes(fp)) {
        return {
            level: 'trusted',
            reason: 'Manifest fingerprint is verified on the operator allowlist',
            fingerprint: fp,
            matchedBy: 'fingerprint'
        };
    }
    if (id && policy.trustedIds.map((s) => s.toLowerCase()).includes(id)) {
        return {
            level: 'known',
            reason: `Manifest id "${id}" is on the operator allowlist`,
            fingerprint: fp,
            matchedBy: 'id'
        };
    }
    return {
        level: 'unknown',
        reason: 'Manifest is not on any operator list',
        fingerprint: fp
    };
}

const TRUST_ORDER: Record<TrustLevel, number> = {
    blocked: 0,
    unknown: 1,
    known: 2,
    trusted: 3
};

export interface ImportPolicyDecision {
    /** False → reject the import outright (denylist + enforcement). */
    allowed: boolean;
    trustLevel: TrustLevel;
    reason: string;
    fingerprint: string;
    /**
     * Whether the addon may be auto-enabled per the configured minimum trust
     * level. When false the caller must force enable=false + `pending`.
     */
    mayAutoEnable: boolean;
    /** How the classification matched: fingerprint, id, or no list. */
    matchedBy?: 'fingerprint' | 'id';
    /** Extra finding to merge into the validation result (when blocked). */
    finding?: AddonValidationFinding;
}

export function evaluateImportPolicy(
    manifest: StremioManifest,
    policy: MarketplacePolicy
): ImportPolicyDecision {
    const c = classifyManifest(manifest, policy);
    if (c.level === 'blocked' && policy.enforceDenylist) {
        return {
            allowed: false,
            trustLevel: c.level,
            reason: c.reason,
            fingerprint: c.fingerprint,
            mayAutoEnable: false,
            ...(c.matchedBy ? { matchedBy: c.matchedBy } : {}),
            finding: {
                code: 'policy_violation',
                message: c.reason,
                severity: 'error'
            }
        };
    }
    const mayAutoEnable =
        TRUST_ORDER[c.level] >= TRUST_ORDER[policy.minTrustForEnable];
    return {
        allowed: true,
        trustLevel: c.level,
        reason: c.reason,
        fingerprint: c.fingerprint,
        mayAutoEnable,
        ...(c.matchedBy ? { matchedBy: c.matchedBy } : {})
    };
}
