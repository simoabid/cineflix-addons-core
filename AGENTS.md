# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before modifying code.

## Project Overview

`addons-core` (`@addons/core`) is a self-hostable backend that turns any **Stremio
addon** into a movie/TV source provider and exposes it through an **OMSS-compliant
HTTP API** (the same contract the CINEFLIX frontend speaks). It is a standalone
**nested Git repository**: its own `.git` history and `origin` remote are
authoritative. The parent workspace and sibling projects (`cineflix-core`,
`pstream-extension/`, etc.) are **out of scope — never modify them** (ADR 0001).

- Addons are installed by manifest URL, Stremio account, or a repository list.
- Enabled addons become providers (`addon:<slug>`) in `/v1/providers`; the
  frontend waterfall queries `/v1/movies/:tmdbId/providers/:providerId` (and TV)
  one-by-one.
- Debrid (Real-Debrid / AllDebrid / Premiumize) resolves cached torrent
  (`infoHash`) streams into playable HTTP links.
- Streams/subtitles are served through short-lived playback grants
  (`/v1/proxy/grant/:id`), never an open proxy.

## Tech Stack

- **Node >= 20** (`engines.node`), ESM (`"type": "module"`). CI runs Node 20; the
  Docker image is built on Node 22.
- **TypeScript** (strict, `module`/`moduleResolution: NodeNext`, target ES2022),
  compiled with `tsc` to `dist/`.
- **`@omss/framework`** — the OMSS server (Fastify-based) providing `/v1/health`,
  `/v1/providers`, bulk `/v1/movies`/`/v1/tv`, and native Stremio routes.
- Runtime deps: `pg` (Postgres storage), `redis`, `undici`, `dotenv`, `nanoid`,
  `js-yaml`.
- Tests: **Node's built-in test runner** (`node:test` + `node:assert/strict`).
  No Jest/Vitest. `fastify` is available transitively via `@omss/framework` and
  used in contract tests.
- Lint: ESLint 9 flat config (`eslint.config.js`) + `typescript-eslint` +
  `eslint-config-prettier`. Format: Prettier (`.prettierrc`).
- Admin UI: plain JS/CSS/HTML in `public/admin/` — not compiled by `tsc`, not
  linted (excluded in `eslint.config.js`).

## Repository Structure

| Path | Role |
|---|---|
| `src/config.ts` | **All** environment configuration. `loadConfig()`, `assertProductionSafe()`, `assertCorsSafe()`, `resolvePublicUrl()`. Fail-closed production validation. |
| `src/server.ts` | Composition root. Wires storage, manager, cache, jobs, security, routes, health, metrics, admin UI onto the `OMSSServer`. |
| `src/addons/` | `AddonManager` (source of truth for installed addons), `createAddonStore` (file / postgres / redis), types. |
| `src/storage/` | `IStorageBackend` abstraction: `file` (default), `postgres` (transactional, auto-migrations); legacy importer. |
| `src/stremio/` | Stremio Addon Protocol client, provider, id/mapping. |
| `src/debrid/` | Magnet helpers, provider resolvers, service singleton, torrent→source bridge. |
| `src/import/` | URL, Stremio account, and repository importers. |
| `src/egress/` | Residential proxy egress (`scrapeFetch`) + global stream dispatcher. |
| `src/health/` | Background manifest health monitor. |
| `src/jobs/` | Background job engine (locks, handlers: imports, maintenance, uncached transfers). |
| `src/routes/` | Fastify route registration: `addons`, `import`, `jobs`, `auth`, `openapi`. |
| `src/security/` | auth, audit, csrf, httpSecurity, playbackGrant, proxyRoute, rateLimit, redaction, secrets, secureFetch, urlPolicy. Re-exported via `security/index.ts`. |
| `src/cache/` | `CacheManager` (namespaced keys, SWR, single-flight). |
| `src/providers/selection.ts` | `ProviderSelectionService` — authoritative provider ordering/selection. |
| `src/media/` | `MediaIdentityService` — TMDB id/taxonomy resolution + cache. |
| `src/validation/` | `schemas.ts` (validators), `validator.ts` (pre-handler + optimistic concurrency). |
| `src/telemetry/` | Structured JSON logger + W3C trace propagation. |
| `src/metrics/` | Prometheus metrics + snapshots. |
| `src/openapi/` | OpenAPI 3.1 spec; `generateDocs.ts` writes `docs/openapi.json` + `docs/openapi.yaml`. |
| `src/capabilities/` | Manifest capability derivation. |
| `src/reliability/` | Circuit-breaker registry (per-provider failure tracking). |
| `src/sources/` | Upstream URL normalization / dedup. |
| `src/subtitles/` | Subtitle aggregation. |
| `src/priority.ts`, `src/progressiveScrape.ts` | Default addon timeout/sort; progressive single-provider scrape. |
| `public/admin/` | Static admin UI. |
| `test/` | `*.test.js` suites, `test/fixtures/` golden files. |
| `docs/` | ADRs (`docs/adr/`), operational runbooks (`docs/runbooks/`), generated OpenAPI. |
| `data/` | Runtime persistence (`addons.json`, `audit.jsonl`, scratch test files). **Git-ignored.** |
| `dist/`, `node_modules/` | Generated. **Never commit.** |

## Commands

```bash
npm ci                    # install exactly the committed dependency versions
cp .env.example .env      # create local config (TMDB_API_KEY is required to start)

npm run dev               # tsx watch src/server.ts (dev server)
npm run build             # tsc -> dist/
npm start                 # build, then run dist/server.js
npm run serve             # run the already-built dist/server.js
npm test                  # build, then node --test test/*.test.js  (currently 278 passing)
npm run lint              # eslint src
npm run clean             # rimraf dist

npm run format            # CAUTION: prettier --write over ALL of src/ — prefer formatting only the files you changed (below)
npx prettier --write <changed-files>   # format only your files, avoiding unrelated diffs
npm run format:check      # prettier --check src  (fails at baseline; see below)
```

- **No DB migration/seed scripts.** Postgres migrations run automatically at
  storage init (`src/storage/migrations/`); the postgres backend connects via
  `DATABASE_URL` (or standard `PG*` vars).
- **Regenerate OpenAPI docs** (no npm script — run directly; verified
  idempotent, produces no diff):
  `npx tsx src/openapi/generateDocs.ts`
- **`format:check` currently fails on ~24 committed `src/` files** that do not
  match the committed Prettier config. This is a pre-existing baseline, not
  caused by your work. Do not reformat those files in your task; fix it only
  for the files you change.

## Development Workflow

1. Understand the request; find the relevant module.
2. **Search for an existing abstraction before writing a new one** (see
   Architecture). Prefer extending what exists over introducing a parallel
   implementation.
3. **Read the relevant ADR** in `docs/adr/` when your change touches repository
   boundaries, security, architecture, or CI/quality-gate behavior. Flag any
   conflict with an accepted ADR decision instead of silently deviating.
4. Prefer the smallest change that fits existing patterns.
5. Run the quality gates (ADR 0002 / CI), in order:
   `npm run build` → `npm test` → `npm run format:check` → `npm run lint`.
   - `build`, `test`, and `lint` must pass.
   - `format:check` will report pre-existing violations on ~24 untouched files.
     Verify only that **your** changed files are clean; attribute the rest to
     baseline drift.
6. Format **only the files you changed** with `npx prettier --write <files>`,
   then address any lint findings, so the gates pass without editing the tree.
7. Add/adjust tests when you change behavior; never weaken existing tests.

## Architecture

- **Env config is centralized in `src/config.ts`.** New settings are added there
  (and documented in `.env.example`) and consumed via `AppConfig` — do not add
  new scattered `process.env` reads. A few legacy direct reads already exist
  (postgres `DATABASE_URL`/`PG*` in `storage/postgres`, proxy vars in
  `egress/scrapeFetch.ts`, `NODE_ENV` checks) — match the centralization
  convention for new settings.
- **`AddonManager` is the source of truth** for addons: it owns the in-memory
  list, persists via the storage backend, keeps the OMSS provider registry in
  sync (one `StremioAddonProvider` per enabled addon), and is revision-driven.
  Cache keys are revision-aware; `server.ts` clears OMSS cache on revision
  change.
- **Persistence goes through the storage layer** (`createAddonStore` +
  `IStorageBackend`, `src/storage/types.ts`): addons, health, debrid config,
  playback grants, audit, and jobs. Backends: `file` (default), `postgres`
  (transactional), or `redis` (`RedisAddonStore`, single-key snapshot). Routes
  should go through `manager` + `storage`, not write files directly.
- **Route registration pattern**: new endpoints are added in `src/routes/`
  (validators in `src/validation/schemas.ts`) and mounted on the Fastify
  instance in `server.ts` via `register*Routes(app, manager, cfg, ...)`. Each
  route:
  - validates params/query/body with validators from `src/validation/schemas.ts`
    and replies with `formatValidationError(issues, request.id)` on failure,
  - guards with `makeAuthGuard(cfg, { role })` — roles `viewer < operator < admin`,
  - enforces rate limits (`enforceRateLimit` / `checkScrapeRateLimit`),
  - checks optimistic concurrency (`checkOptimisticConcurrency`) on mutations,
  - records audit events (`auditMutation`) for mutations.
- **API conventions**: match existing response shapes rather than inventing new
  ones — errors use `{ error: { code, message }, requestId }`, and
  provider-related responses carry `x-provider-revision` (+ `ETag: "rev-<n>"`).
- **All outbound HTTP must respect the SSRF policy**: use `secureFetch` /
  `secureFetchJson` / `urlPolicy` (HTTPS by default; blocks localhost, private,
  link-local, CGNAT, and metadata ranges; revalidates each redirect hop) or the
  egress proxy — never raw `fetch`/`undici` on arbitrary URLs.
- **Never put tokens or keys in query strings, logs, audits, or API
  responses.** Use `redactString`/`redactUrl` from `src/security/redaction.ts`.
  Debrid keys at rest are AES-256-GCM envelope-encrypted (`SecretBox`).
- **Don't weaken the fail-closed startup checks** in
  `assertProductionSafe`/`assertCorsSafe` (`src/config.ts`); production refuses
  to start on anonymous admin, wildcard CORS, missing HTTPS `PUBLIC_URL`,
  missing `SECRETS_MASTER_KEY`, or weak `PLAYBACK_GRANT_SECRET`.
- **Extend existing abstractions, don't fork them.** Before creating a new
  module, search the codebase for an existing one to extend: configuration
  (`src/config.ts`), storage (`src/storage/` + `createAddonStore`), security
  (`src/security/`), validation (`src/validation/schemas.ts`), outbound
  HTTP/egress (`src/security/secureFetch.ts`, `src/egress/`), caching
  (`src/cache/`), telemetry (`src/telemetry/`), provider selection
  (`src/providers/selection.ts`), media identity (`src/media/`), and jobs
  (`src/jobs/`). A parallel implementation is a code smell unless clearly
  justified.

## ADRs

- Consult `docs/adr/` before changing behavior governed by a decision:
  `0001` (repo ownership / boundaries), `0002` (quality gates / CI), `0003`
  (security & trust boundaries).
- If your change conflicts with an accepted ADR, flag it to the user instead of
  silently deviating. Significant new architectural decisions can be recorded as
  new ADRs following the existing format.

## Coding Conventions

- ESM + NodeNext: **imports use explicit `.js` extensions** even for local `.ts`
  sources (e.g. `import { AddonManager } from './addons/manager.js'`).
- Prettier defaults in `.prettierrc`: 4-space indent, single quotes, semicolons,
  `trailingComma: "none"`, print width 80. **Do not add trailing commas.**
- Strict TypeScript. Type Fastify route generics (`Params`, `Querystring`,
  `Body`).
- The codebase is comment-documented: JSDoc file headers, `// ── Section ──────`
  headers, and inline rationale comments explain non-obvious intent — follow
  that style; don't add noise comments to trivial code.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  `refactor:`, `perf:`, `security:`.

## Testing

- Tests are `*.test.js` under `test/` using `node:test` and
  `node:assert/strict`. No third-party test framework — don't add one.
- **Tests import from `../dist/...`**, so a build is required before running
  (`npm test` builds first; after changing `src/`, rebuild before running a
  single test manually: `npm run build && node --test test/<file>.test.js`).
- Contract tests boot a real Fastify app and use `app.inject()` with golden
  fixtures in `test/fixtures/contracts/`. They write scratch runtime files
  under `data/` (git-ignored) — never to tracked locations.
- Keep tests zero-dep/pure where possible; mock external calls (no live TMDB,
  Stremio, or debrid).

## Important Rules

- **This is a nested Git repo.** Before any `git` operation, confirm the repo
  root is the directory containing this file (`git rev-parse --show-toplevel`).
  This repo's own `.git` and `origin` are authoritative — never operate on the
  parent workspace's git history.
- **Parent workspace, sibling projects, and `pstream-extension/` are out of
  scope** unless the user explicitly asks to work outside this repository
  (ADR 0001). Work only inside this repository.
- **Never commit `.env` or secrets.** `.env` is git-ignored. Don't log, print, or
  commit API keys, debrid keys, proxy credentials, or generated secrets.
- **Never hand-edit generated files**: `dist/`, `node_modules/`,
  `docs/openapi.json`, `docs/openapi.yaml` (regenerate instead). `data/` is
  runtime state — don't commit it.
- **Don't modify Docker/Compose/CI config** (`Dockerfile`, `compose.yml`,
  `.github/workflows/ci.yml`) unless the task requires it.
- **Don't add a dependency when an existing one suffices** (e.g. `@omss/framework`
  already provides Fastify; tests use `node:test`).
- **Don't do broad refactors** for a focused task; keep formatting-only changes
  strictly to the files you touched.
- **Don't delete working code** just because it looks unused — verify consumers
  (e.g. framework patching in `server.ts`).
- **Docs can drift from code.** The README still says "33 tests" (actual: 278)
  and omits newer modules/storage backends. Trust `src/` and the ADRs over
  README prose.
- Verify with the quality gates before claiming a task is done.

## Security

- Preserve fail-closed production behavior (`assertProductionSafe`). New env
  options must not silently disable auth, audit, CSRF, or the SSRF policy.
- Outbound fetches of arbitrary URLs must pass through `secureFetch`/`urlPolicy`
  or the egress proxy.
- Keep secrets out of logs/audits/errors/API responses via redaction.
- Management/destructive routes: auth guards + rate limits + audit + optimistic
  concurrency — follow the existing route pattern.
- See `docs/runbooks/` for operational response procedures and
  `docs/adr/0003-phase-1-security-boundaries.md` for the security model.

## Definition of Done

- `npm run build` passes; `npm run lint` passes; `npm test` passes (all tests).
- `npm run format:check` shows **no new violations in the files you changed**.
  The ~24 files failing at baseline are pre-existing drift — not your
  responsibility to fix, and never an excuse for violations you introduce.
- No secrets added; no generated/runtime files committed.
- Diff reviewed; no unrelated formatting or refactoring changes.
