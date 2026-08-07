# ADR 0003 — Phase 1 security and trust boundaries

- **Status:** Accepted
- **Date:** 2026-08-04
- **Context:** Production readiness plan §4 (Phase 1)

## Decision

Phase 1 hardens `addons-core` so it can be exposed beyond localhost without
open administration, open proxying, or silent secret leakage.

### 1. Administration authentication

- Explicit `AUTH_MODE`: `disabled` | `static-token` | `reverse-proxy` |
  `service-jwt` | `oidc` (reserved, fails closed).
- Production refuses to start with anonymous administration, missing tokens
  for the chosen mode, wildcard CORS, missing `PUBLIC_URL` (https), legacy
  open proxy, or missing `SECRETS_MASTER_KEY` when required.
- Credentials are accepted via headers / HttpOnly session cookies only —
  never query strings.
- Minimum roles: `viewer` < `operator` < `admin`.
- Every management mutation is append-only audited (JSONL + in-memory ring).
- Destructive / high-cost routes are rate-limited per actor+IP.

### 2. Playback authorization (replaces open proxy)

- Providers issue short-lived `PlaybackGrant` records.
- Public clients redeem `GET /v1/proxy/grant/:id` (opaque) or
  `GET /v1/proxy/token/:token` (compact HMAC).
- Legacy `GET /v1/proxy?data=` is blocked when `SECURE_PROXY=true` (default)
  and is forbidden in production.
- Grants store approved upstream headers server-side; they are never placed
  in query strings.

### 3. Outbound URL / SSRF policy

Shared policy for proxy, imports, manifests, and redirects:

- HTTPS by default; HTTP only via `ALLOW_HTTP_UPSTREAMS` (off in production).
- Reject embedded credentials, localhost, private/link-local/CGNAT/metadata
  ranges (IPv4 + IPv6, including IPv4-mapped).
- DNS resolution checked before connect; every redirect hop revalidated.
- Body / redirect / timeout caps on secure fetches.

### 4. Secrets

- Debrid API keys (and future secrets) use AES-256-GCM envelope encryption
  (`enc:v1:…`) with `SECRETS_MASTER_KEY`.
- Central redaction utility for logs, audits, errors, and API responses.
- Admin UI no longer stores long-lived tokens in `localStorage`.

### 5. HTTP / browser hardening

- Exact CORS allowlist in production.
- Security headers (CSP for admin UI, nosniff, frame deny, referrer, HSTS
  signal in production, Permissions-Policy).
- Central safe error mapper (no stacks, no raw upstream bodies/secrets).
- Query length and body size limits.

## Consequences

- Local dev without `ADMIN_TOKEN` still works (`AUTH_MODE=disabled` on
  localhost). Binding `0.0.0.0` without auth requires
  `ALLOW_INSECURE_ADMIN=true`.
- CINEFLIX clients receive grant URLs instead of `?data=` payloads when
  `SECURE_PROXY=true`. Range requests and HLS/DASH manifest rewriting remain
  supported via nested grants.
- Operators must set `ADMIN_TOKEN`, `SECRETS_MASTER_KEY`, `PUBLIC_URL`, and
  `CORS_ORIGIN` before production deploy.
- Multi-instance grant storage (Redis) and full OIDC are deferred to later
  phases; in-process grants are correct for single-node production.

## References

- `src/security/*`
- `src/config.ts` (`assertProductionSafe`)
- `PRODUCTION_READINESS_PLAN.md` §4
