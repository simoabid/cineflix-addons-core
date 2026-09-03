# Configuration reference

All configuration lives in `src/config.ts` and is documented inline in
[.env.example](../.env.example) — that file is the exhaustive list with
defaults; this reference explains the shape and the unsafe combinations. New
settings always go through `loadConfig()` — never scattered `process.env`
reads.

## Tiers

**Required to start (every environment)**

| Variable | Notes |
|---|---|
| `TMDB_API_KEY` | `@omss/framework` identity resolution. |
| `PORT`, `HOST` | Defaults `3006`, `localhost`; production uses `HOST=0.0.0.0`. |

**Required in production** (start-up fails otherwise — see
`assertProductionSafe`/`assertCorsSafe`):

| Variable | Rule |
|---|---|
| `PUBLIC_URL` | Exact external `https://` origin, no trailing slash. Playback-grant URLs are asserted against it at boot. |
| `CORS_ORIGIN` | Exact origin(s); `*` is refused. |
| `SECRETS_MASTER_KEY` | 32-byte base64/hex. Encrypts debrid keys at rest. |
| `PLAYBACK_GRANT_SECRET` | 32+ chars. Signs/encrypts playback grants; dev fallback refused. |
| `AUTH_MODE` ≠ `disabled` | `static-token` (default), `reverse-proxy` (requires `TRUSTED_PROXY_CIDRS`), or `service-jwt` (requires `SERVICE_JWT_SECRET`). `oidc` is reserved and fails closed. |

**Explicitly unsafe combinations** (refused or dangerous):

| Combination | Behavior |
|---|---|
| `AUTH_MODE=disabled` + non-loopback host | Refused unless `ALLOW_INSECURE_ADMIN=true` (explicit dev acknowledgement). |
| `CORS_ORIGIN=*` in production | Refused. |
| `PUBLIC_URL` with `http://` in production | Refused. |
| `PLAYBACK_GRANT_SECRET` = dev fallback in production | Refused. |
| `ALLOW_LEGACY_PROXY=true` in production | Refused — arbitrary proxy payloads stay closed. |
| `ALLOW_HTTP_UPSTREAMS=true` in production | Refused — outbound is HTTPS-only. |
| `AUTH_MODE=reverse-proxy` without `TRUSTED_PROXY_CIDRS` in production | Refused — forwarded user headers must come from a trusted edge. |

## Key groups (full list in `.env.example`)

- **Server** — `PORT`, `HOST`, `NODE_ENV`, `PUBLIC_URL`, `CORS_ORIGIN`,
  `INTERNAL_DEBUG`.
- **TMDB** — `TMDB_API_KEY`, `TMDB_CACHE_TTL`, `TMDB_API_BASE_URL` (mirror
  override; must be https in production).
- **Cache** — `CACHE_TYPE` (`memory` | `redis`), `REDIS_HOST/PORT/PASSWORD`.
- **Addon persistence** — `ADDONS_STORE` (`file` | `postgres` | `redis`),
  `ADDONS_DATA_FILE`, `DATABASE_URL`/`PG*` (postgres), `ADDONS_SEED_URLS`
  (first-boot seeding; the hermetic-install path used by tests).
- **Auth & sessions** — `AUTH_MODE`, `ADMIN_TOKEN`, `ADMIN_TOKEN_ROLE`,
  `AUTH_SESSION_SECRET`, `AUTH_SESSION_TTL_SEC`, `SERVICE_JWT_SECRET`,
  `AUTH_PROXY_USER_HEADER`, `AUTH_PROXY_ROLE_HEADER`, `TRUSTED_PROXY_CIDRS`.
- **Secrets** — `SECRETS_MASTER_KEY`, `REQUIRE_SECRETS_MASTER_KEY`.
- **Playback proxy** — `SECURE_PROXY`, `ALLOW_LEGACY_PROXY`,
  `PLAYBACK_GRANT_SECRET`, `PLAYBACK_GRANT_TTL_SEC`, `PROXY_TIMEOUT_MS`,
  `PROXY_MAX_MANIFEST_BYTES`, `PROXY_MAX_BUFFER_BYTES`,
  `PROXY_MAX_STREAM_BYTES`.
- **Outbound/SSRF policy** — `ALLOW_HTTP_UPSTREAMS`,
  `OUTBOUND_HOST_ALLOWLIST`, `OUTBOUND_HOST_ALLOW_SUFFIXES`,
  `IMPORT_MAX_URLS`, `IMPORT_MAX_CONCURRENT`, `IMPORT_MAX_BYTES`,
  `IMPORT_TIMEOUT_MS`, `IMPORT_ENABLE_ON_INSTALL`.
- **Concurrency pools** — `CONCURRENCY_*` per pool (bulk, progressive,
  provider-stream, outbound-host, subtitles, manifest, health, debrid,
  proxy-stream, hls-segment) plus queue depth/timeout.
- **Graceful shutdown** — `TERMINATION_GRACE_PERIOD_MS`,
  `SHUTDOWN_DRAIN_JOBS`.
- **Multi-instance** — `CLUSTER_BUS_ENABLED` (Redis pub/sub for revision +
  cache invalidation).
- **Capacity & cost** — `MAX_CONCURRENT_STREAMS_*`, `BULK_MAX_PROVIDERS_PER_REQUEST`,
  `SOURCE_LOOKUP_DEADLINE_MS`, `PLAYBACK_GRANT_MAX_ACTIVE`,
  `PLAYBACK_GRANT_MAX_PER_REQUEST`, `PROVIDER_DAILY_CALL_BUDGET`,
  `EGRESS_DAILY_BUDGET_MB`, `EGRESS_PROXY_DAILY_BUDGET_MB`, rate-limit quotas.
- **Quarantine** — `QUARANTINE_*` (auto-quarantine of repeatedly failing
  providers).
- **Egress proxy** — `SCRAPE_PROXY_URL`, `SCRAPE_PROXY_MODE`,
  `SCRAPE_PROXY_STREAM` ([docs/egress-proxy.md](egress-proxy.md)).

## Changing settings at runtime

Some settings are runtime-mutable through the authenticated management API
instead of env: debrid provider/keys (`PATCH /v1/settings/debrid`), addon
ordering/timeouts (`PATCH /v1/addons/reorder`, `/refresh`). These persist via
the storage backend and are revision-tracked; cache keys are revision-aware so
changes invalidate downstream caches immediately.
