# Installation guide

Ways to run `addons-core`: local development, Docker/Compose, or a production
deployment behind a TLS edge. For configuration semantics see
[docs/configuration.md](configuration.md); for the production go-live
checklist see [docs/security-checklist.md](security-checklist.md).

## Prerequisites

- Node >= 20 (CI runs Node 20; the image is Node 22)
- A TMDB API key (required to start — `@omss/framework` uses it for identity)
- For production: a domain with TLS, and (recommended) Redis + Postgres

## Local development

```bash
git clone https://github.com/simoabid/cineflix-addons-core.git
cd addons-core
npm ci                 # exact locked dependency versions
cp .env.example .env   # then set at least TMDB_API_KEY
npm run dev            # tsx watch src/server.ts
```

Verify: `curl http://127.0.0.1:3006/health/live` → `200`, then open
`http://127.0.0.1:3006/admin` (in development without `ADMIN_TOKEN` the admin
UI runs unauthenticated on loopback only — never expose this).

Run the quality gates locally:

```bash
npm test              # build + full test suite
npm run lint          # eslint
npm run format:check  # prettier (some baseline files drift; see AGENTS.md)
```

## Docker / Compose

```bash
cp .env.example .env   # set TMDB_API_KEY (and production vars when exposing)
docker compose up -d --build
curl http://127.0.0.1:3006/health/live
```

The container is hardened (digest-pinned base, non-root, read-only root
filesystem, dropped capabilities, liveness HEALTHCHECK — see
[docs/supply-chain.md](supply-chain.md)). Addon state persists in the
`addons-data` volume at `/data/addons.json`.

## Production deployment

1. **Persist state** — Postgres (`ADDONS_STORE=postgres` with `DATABASE_URL`)
   for multi-instance, or the file store on a persistent volume for
   single-node (an accepted mode, see [docs/environments.md](environments.md)).
2. **Cache/grants** — Redis (`CACHE_TYPE=redis`) for shared cache and grants.
3. **Secrets** — `SECRETS_MASTER_KEY` (32-byte base64/hex) and
   `PLAYBACK_GRANT_SECRET` (32+ chars) are mandatory; generation one-liners
   are in `.env.example`.
4. **Auth** — set `AUTH_MODE` (`static-token`, `reverse-proxy`, or
   `service-jwt`) and `ADMIN_TOKEN`; see [docs/admin-auth.md](admin-auth.md).
5. **Edge** — deploy behind TLS with `PUBLIC_URL=https://addons.<domain>`
   (see [docs/reverse-proxy.md](reverse-proxy.md)). The server refuses to
   start on insecure production settings and asserts playback-grant URLs
   match `PUBLIC_URL` at boot.
6. **Egress** (optional) — residential proxy for scrape/stream egress:
   [docs/egress-proxy.md](egress-proxy.md).
7. **Observability** — expose `/metrics` behind auth; wire alerts per
   [docs/observability.md](observability.md).
8. **Backups** — schedule `scripts/backup.sh`; see
   [docs/backup-restore.md](backup-restore.md).

## First-run checklist

```sh
curl -H "x-admin-token: $ADMIN_TOKEN" https://addons.<domain>/v1/providers
# install an addon:
curl -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
     -d '{"url":"https://example.tld/manifest.json"}' \
     https://addons.<domain>/v1/addons/import/url
```

Installed addons appear as providers in `/v1/providers` and (when
stream-capable) serve the progressive waterfall for the CINEFLIX frontend
([docs/integration-cineflix.md](integration-cineflix.md)).
