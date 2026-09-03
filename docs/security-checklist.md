# Production security checklist

Go-live gate for exposing `addons-core` to the public internet. Every item is
enforced mechanically where possible (fail-closed startup checks in
`src/config.ts`, CI gates, startup assertions) — the checklist makes them
explicit for operators.

## Startup / configuration

- [ ] `NODE_ENV=production` — enables all fail-closed validation.
- [ ] `PUBLIC_URL` set to the exact external `https://` origin (no trailing
      slash); startup assertion verifies playback-grant URLs build with it.
- [ ] `CORS_ORIGIN` is an exact origin list — `*` refuses to start.
- [ ] `AUTH_MODE` is not `disabled`; `ADMIN_TOKEN` (or service-JWT /
      reverse-proxy headers) is set from a secrets manager.
- [ ] `SECRETS_MASTER_KEY` is a 32-byte base64/hex value; stored with the
      same care as the debrid credentials it protects.
- [ ] `PLAYBACK_GRANT_SECRET` is a 32+ char random value (dev fallback is
      refused).
- [ ] `ALLOW_HTTP_UPSTREAMS=false` — outbound is HTTPS-only.
- [ ] `ALLOW_LEGACY_PROXY` unset/false — arbitrary `/v1/proxy?data=` payloads
      are rejected.
- [ ] Optionally `OUTBOUND_HOST_ALLOWLIST` to pin addon/egress hosts.

## Network / edge

- [ ] TLS at the edge with automated certificates; HTTP redirected to HTTPS
      ([docs/reverse-proxy.md](reverse-proxy.md)).
- [ ] Admin surface (`/admin`, `/v1/auth`, management routes) IP-allowlisted
      or behind SSO at the edge.
- [ ] Request body limit ≤ 1 MiB; `proxy_buffering off` for `/v1/proxy/*`.
- [ ] Container: non-root, read-only root filesystem, dropped capabilities,
      resource limits (see `compose.yml`).

## Auth & API

- [ ] Anonymous management calls return 401 (test: `curl /v1/addons`).
- [ ] Roles: `viewer < operator < admin`; only `admin` mutates dangerous
      settings (auth, debrid, quarantine).
- [ ] Session cookies are HttpOnly with CSRF protection for the admin UI;
      tokens are never accepted via query strings.
- [ ] Rate limits tuned for public exposure: `ANON_SCRAPE_RATE_LIMIT_PER_MIN`,
      `PROXY_RATE_LIMIT_PER_MIN`, `MAX_CONCURRENT_STREAMS_PER_IP`.

## Data & secrets

- [ ] Debrid keys configured via the admin API are encrypted at rest
      (AES-256-GCM) and never appear in logs, audits, or API responses
      (`redactString`/`redactUrl` everywhere).
- [ ] `SECRETS_MASTER_KEY` backed up per the secrets-manager strategy —
      without it, restored snapshots' debrid keys cannot be decrypted
      ([docs/backup-restore.md](backup-restore.md)).
- [ ] Backups encrypted (`scripts/backup.sh --age-recipient` / `--gpg-key`).
- [ ] No production addon URLs or debrid credentials in shared dev
      environments ([docs/environments.md](environments.md)).

## Operations

- [ ] `/metrics` behind auth; alerts wired
      ([docs/observability.md](observability.md)).
- [ ] Runbooks reviewed: [docs/runbooks/](runbooks/) — provider failures,
      debrid outage, SSRF incident, credential rotation, rollback.
- [ ] Backup schedule + quarterly restore drill scheduled.
- [ ] CI green on the deployed commit: build, tests, coverage, dead-code,
      secret scan, format, lint, container build + Trivy.
- [ ] Image digest + SBOM recorded for the release
      ([docs/supply-chain.md](supply-chain.md)).
