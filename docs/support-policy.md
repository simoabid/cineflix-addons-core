# Compatibility and support policy

What consumers of `addons-core` can rely on, and how change is managed.

## API compatibility

- **OMSS contract** — `/v1/movies/:id`, `/v1/tv/...`, `/v1/providers`, health
  routes, and response shapes follow the OMSS contract served by
  `@omss/framework`. Breaking OMSS changes arrive only with a framework major
  bump and are called out in release notes.
- **Management API** — `/v1/addons*`, `/v1/settings*`, `/v1/jobs*`,
  `/v1/auth*`, `/v1/quarantine*` follow the committed OpenAPI document
  (`docs/openapi.json`). Additive changes (new optional fields, new
  endpoints) are minor versions; removals or reshapes require a deprecation
  window of at least one minor release with `Deprecated` notes in the spec.
- **Error envelope** — `{ error: { code, message }, requestId }` is stable;
  new error codes may appear.
- **`x-provider-revision` / `ETag`** — semantic: monotonically increasing on
  any provider-set mutation. Guaranteed.

## Upstream compatibility

- **Stremio addon protocol** — manifests, `/stream`, `/subtitles` per the
  public protocol; capability derivation tolerates partial/odd manifests
  (validation findings surface on import).
- **Debrid providers** — Real-Debrid, AllDebrid, Premiumize. Provider API
  changes are handled inside resolvers; a resolver may be disabled at runtime
  if its upstream breaks irrecoverably (documented in release notes).
- **TMDB** — v3 API; `TMDB_API_BASE_URL` override supported for mirrors.

## Configuration compatibility

- Environment variables are additive; renames/removals are announced and keep
  one minor release of dual-reading where feasible. Production fail-closed
  checks never regress (they only tighten with notice).
- Storage: `file` remains the supported single-node mode indefinitely;
  `postgres` is the multi-instance mode. Migrations run automatically at
  storage init and are backward-compatible (down migrations are not
  supported — restore from backup instead, see
  [docs/backup-restore.md](backup-restore.md)).

## Runtime support

| Component | Policy |
|---|---|
| Node.js | Current LTS line (>= 20; CI on 20, image on 22). Drops with the LTS EOL. |
| `@omss/framework` | Carefully reviewed minor bumps; majors are releases of their own. |
| Browsers (admin UI) | Evergreen Chrome/Firefox/Safari; no IE/legacy targets. |
| Redis | 7.x when `CACHE_TYPE=redis`. |
| Postgres | 14+ when `ADDONS_STORE=postgres`. |

## Security fixes

Security regressions are fixed on `main` and released immediately as patch
versions; the affected deployments should track `main` tags or the container
digest updates (see [docs/supply-chain.md](supply-chain.md)). Disclosures:
open a restricted issue or contact the maintainers — do not open public
tickets with exploit detail.

## Deprecation procedure

1. Announce in release notes + spec (`deprecated: true` on the operation).
2. Keep behavior for one minor release (log a warning metric/tag).
3. Remove in the next major (or minor with explicit notice for management-API
   surfaces not consumed by the CINEFLIX frontend).
