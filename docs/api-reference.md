# API reference

The authoritative, generated reference is the OpenAPI 3.1 document served by
the service itself and committed to this repository:

- `GET /v1/openapi.json` / `GET /v1/openapi.yaml` (also `GET /v1/docs` for a
  browsable page)
- Generated files: [`docs/openapi.json`](openapi.json) /
  [`docs/openapi.yaml`](openapi.yaml) — regenerate with
  `npx tsx src/openapi/generateDocs.ts` (CI keeps them in sync via contract
  tests)

This page is the orientation layer: what each route family is *for*. Request/
response shapes, auth requirements, and error codes live in the OpenAPI
document; error envelope is always
`{ "error": { "code", "message }, "requestId" }`.

## Route families

### Health & operations
`GET /health/live` (liveness — event loop only) · `GET /health/ready`
(readiness — storage/cache/jobs) · `GET /health/dependencies` · `GET /metrics`
(Prometheus, auth) · `GET /debug/providers/:id`, `GET /debug/traces` (admin)

### Providers (CINEFLIX waterfall)
`GET /v1/providers` — ordered provider list with `x-provider-revision`/ETag ·
`GET /v1/providers/meta`, `/v1/providers/diagnostics`

### Sources
`GET /v1/movies/:id`, `GET /v1/tv/:id/seasons/:s/episodes/:e` — OMSS aggregate
(all eligible providers, cached) ·
`GET /v1/movies/:tmdbId/providers/:providerId` and the TV equivalent —
progressive single-provider waterfall (the frontend's primary path) ·
`GET /v1/refresh/:responseId`

### Subtitles
`GET /v1/subtitles` — aggregates all subtitle-capable addons (IMDb/TMDB id,
season/episode, language filters)

### Playback proxy
`GET /v1/proxy/grant/:id` — redeem a short-lived, signed playback grant
(Range-aware streaming) · `GET /v1/proxy/token/:token` — compact token form.
The legacy open `?data=` proxy is blocked by default and always in production.

### Addon management (auth; roles viewer < operator < admin)
`GET /v1/addons` · `POST /v1/addons/import/url|stremio|repository` ·
`DELETE /v1/addons/:id` · `PATCH /v1/addons/reorder` ·
`POST /v1/addons/:id/refresh`, `/probe`, `POST /v1/addons/health/check` ·
`GET /v1/audit` (admin)

### Settings & debrid (auth)
`GET/PATCH /v1/settings`, `GET /v1/settings/export`,
`POST /v1/settings/import` (redacted export/import) ·
`GET/PATCH /v1/settings/debrid`, `POST /v1/settings/debrid/check`

### Jobs & quarantine (auth)
`GET /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel`, `/retry` ·
`GET /v1/quarantine`, `POST /v1/quarantine/:providerId/release`

### Native Stremio re-exposure
`GET /stremio/manifest.json`, `GET /stremio/stream/:type/:id` — enabled with
`STREMIO_ADDON=true`, the service presents itself as a Stremio addon (see
[docs/integration-stremio.md](integration-stremio.md))

## Conventions

- **Optimistic concurrency** — mutations accept a revision header; stale
  revisions fail with a conflict error.
- **Provider revision** — provider/sourced responses carry
  `x-provider-revision` (+ `ETag: "rev-<n>"`); clients use it to detect
  provider-set changes.
- **Rate limits** — scrape and proxy quotas per IP
  (`X-RateLimit-*` headers; `429` with `Retry-After`).
- **Pagination** — audit and job lists follow the OpenAPI schemas.

See [docs/concepts.md](concepts.md) for the behavioral model behind these
endpoints (bulk vs progressive vs subtitle aggregation, health vs readiness,
direct vs debrid streams).
