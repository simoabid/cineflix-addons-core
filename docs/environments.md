# Environments

Phase 10 §13.2 — every environment is documented with its base URL, auth
requirements, CORS policy, secrets source, and backup policy. **Never use
production addon configurations or debrid credentials in shared development
environments** — addon manifests embed personalized transport URLs and debrid
configurations contain paid API keys.

## Matrix

| | local | development | staging | production |
|---|---|---|---|---|
| Purpose | single-operator laptop | shared integration target | pre-release rehearsal | live service |
| Base URL | `http://127.0.0.1:3006` | `https://addons-dev.<domain>` | `https://addons-staging.<domain>` | `https://addons.<domain>` |
| `NODE_ENV` | `development` | `development` | `production` | `production` |
| `PUBLIC_URL` | unset (loopback fallback) | dev HTTPS origin | staging HTTPS origin | production HTTPS origin (required, https) |
| `AUTH_MODE` | `disabled` (loopback only) | `static-token` (shared dev token) | `static-token` or `reverse-proxy` | `static-token` / `reverse-proxy` / `service-jwt` — anonymous admin is refused |
| `ADMIN_TOKEN` source | optional, operator-local | dev secrets store (rotated monthly) | staging secrets store (separate value) | production secrets manager (never shared) |
| `CORS_ORIGIN` | `*` acceptable on loopback | exact dev origin(s) | exact staging origin | exact production origin — `*` refuses to start |
| `SECRETS_MASTER_KEY` | optional (dev fallback) | required, dev-only value | required, staging value | required, production value (dual-key rotation supported) |
| `PLAYBACK_GRANT_SECRET` | optional fallback | required for shared env | required | required (dev fallback refused) |
| `ALLOW_HTTP_UPSTREAMS` | `true` allowed | `true` allowed | `false` | `false` |
| Cache | `memory` | `memory` or redis (shared dev) | redis | redis (or memory for single-node) |
| Addon store | `file` | `file` or `postgres` | `postgres` | `postgres` (multi-instance) or `file` (single-node, accepted mode) |
| Egress proxy | off | optional | on (staging egress pool) | on (production pool, budgeted) |
| Logging/trace dest | stdout | stdout + dev log sink | stdout → centralized log store | stdout → centralized log store + alerting |
| Rate limits | defaults | defaults, looser scrape quota | production-like | production values |
| Feature flags | all dev flags allowed | dev flags | flags as shipped | only reviewed flags |
| Backups | none | daily, 7-day retention | daily, 14-day retention + weekly restore drill | daily + weekly drills, see docs/backup-restore.md |
| Data policy | personal addons OK | sanitized addon set only | staging fixture set (no production URLs) | production data; debrid keys AES-256-GCM at rest |

## Rules that hold in every environment

1. **Fail-closed startup** (`src/config.ts` `assertProductionSafe` /
   `assertCorsSafe`) cannot be bypassed by flags — production refuses to start
   on anonymous admin, wildcard CORS, missing HTTPS `PUBLIC_URL`, missing
   `SECRETS_MASTER_KEY`, or weak `PLAYBACK_GRANT_SECRET`.
2. **Credential separation** — each environment has its own TMDB key, debrid
   tokens, admin tokens, and secrets master key. A leak in one environment is
   rotated without touching the others (docs/runbooks/credential-rotation.md).
3. **No production data flows downhill.** Staging fixtures are sanitized
   exports (`GET /v1/settings/export` with redaction), never raw copies of
   `data/addons.json`.
4. **Every environment boots with the same gates** — CI, secret scan, and the
   startup grant-origin assertion (ADR 0005 / Phase 10 §13.3).
