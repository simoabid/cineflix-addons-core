# addons-core

A self-hostable backend that turns **Stremio addons** into movie/TV sources and
exposes them through an **OMSS-compliant HTTP API** — the same contract the
CINEFLIX frontend already speaks to `cineflix-core`. Point CINEFLIX at an
`addons-core` instance and it plugs in with **zero frontend changes**.

Where `cineflix-core` scrapes ~58 provider sites directly, `addons-core`
aggregates **any Stremio addon** you install. Each installed addon becomes its
own source provider, so the frontend's progressive waterfall queries them
one-by-one (best → worst).

---

## Features

- **Any Stremio addon as a source** — install by manifest URL, and it becomes an
  OMSS provider (`addon:<slug>`) visible in `/v1/providers`.
- **Three import paths**
  - **URL** — paste one or many `manifest.json` / transport URLs.
  - **Stremio account** — logs into `api.strem.io` and imports your entire
    installed addon collection (email+password or `authKey`).
  - **Repository / internet** — any URL returning a JSON/text list of addon URLs.
- **Debrid resolution** — torrent (`infoHash`) streams from addons like
  Torrentio / MediaFusion / Comet are resolved into playable HTTP links via
  **Real-Debrid**, **AllDebrid**, or **Premiumize**. Cached torrents only;
  uncached magnets are skipped so queries stay snappy. Configure via env
  (`DEBRID_*`) or the admin UI (env takes precedence and locks the UI).
- **OMSS-compatible** — `/v1/health`, `/v1/providers`, bulk + progressive
  movie/TV routes, `/v1/subtitles`, and `/v1/proxy` (all from `@omss/framework`).
- **Self-host on EC2 without IP blocks** — optional residential egress proxy for
  both addon API calls and stream fetches.
- **Web admin UI** at `/admin` — import, enable/disable, **drag-and-drop
  reorder**, per-addon timeout editing, search/filter, health badges, debrid
  config + key test, and one-click health sweeps.
- **Health monitoring** — background manifest health checks (interval
  configurable) with optional auto-refresh of manifests; manual trigger via
  admin or `POST /v1/addons/health/check`.
- **Customisable & persistent** — per-addon timeouts + ordering; state (addons +
  debrid settings) persisted to a JSON file (default) or Redis.
- **Unit tests** — pure modules covered by Node's built-in test runner
  (`npm test` → 33 tests).
- **Fully separate** from `cineflix-core` — own project, own deps; shares only
  the public `@omss/framework` dependency.

---

## Quick start

```bash
cd addons-core
cp .env.example .env         # set TMDB_API_KEY (required)
npm install
npm run dev                  # or: npm start  (build + run)
```

Open the admin UI: <http://localhost:3006/admin>

Install an addon (example — Cinemeta, or any HTTP-stream / torrent addon):

```bash
curl -X POST http://localhost:3006/v1/addons/import/url \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://v3-cinemeta.strem.io/manifest.json"}'
```

Import a whole Stremio account collection:

```bash
curl -X POST http://localhost:3006/v1/addons/import/stremio \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"••••••"}'
```

### Debrid (optional, unlocks torrent addons)

Most popular Stremio stream addons return **torrent** streams (`infoHash`).
Without debrid those are not browser-playable. Configure a debrid account so
`addons-core` converts cached torrents into direct HTTP(S) URLs:

**Option A — environment** (recommended for production; locks the admin fields):

```env
DEBRID_PROVIDER=realdebrid   # or alldebrid | premiumize
DEBRID_API_KEY=your_api_key
```

**Option B — admin UI** at `/admin` → *Debrid* panel → pick provider, paste key,
*Save*, then *Test key*.

Either way, keys are **never** returned by the API (only `hasKey` / provider /
source). Env config always wins over stored settings.

You can also install debrid-preconfigured addon URLs (Torrentio with your RD
token embedded, etc.) — those already return HTTP streams and work without
native debrid.

---

## Integrate with CINEFLIX

`addons-core` implements the same contract the frontend uses for CinePro. Point
the app's backend URL at it — either way works:

1. **In-app setting** — CinePro settings → *Server URL* → `http://<host>:3006`
   → *Test Connection*.
2. **Env** — set `VITE_CINEPRO_URL=http://<host>:3006` for the frontend build.

Installed, enabled addons appear in `/v1/providers`; the frontend waterfall then
calls `/v1/movies/:tmdbId/providers/addon:<slug>` (and the TV equivalent) per
addon and plays the first playable result.

You can run **both** `cineflix-core` and `addons-core` — just switch the single
`serverUrl` between them (the frontend currently targets one backend at a time).

---

## HTTP API

### OMSS (frontend-facing)
| Method & path | Purpose |
|---|---|
| `GET /v1/health` | Health (`{ status: "operational" }`) |
| `GET /v1/providers` | Installed addons + priority (waterfall order) |
| `GET /v1/movies/:tmdbId` | Bulk movie sources (all addons) |
| `GET /v1/tv/:tmdbId/seasons/:s/episodes/:e` | Bulk TV sources |
| `GET /v1/movies/:tmdbId/providers/:providerId` | **Progressive** single-addon |
| `GET /v1/tv/:tmdbId/seasons/:s/episodes/:e/providers/:providerId` | **Progressive** single-addon |
| `GET /v1/subtitles?tmdbId&imdbId&season&episode&language` | Aggregated subtitles |
| `GET /v1/proxy?data=<json>` | Stream/subtitle proxy (URLs are pre-wrapped) |

### Management (guarded by `x-admin-token` when `ADMIN_TOKEN` is set)
| Method & path | Body | Purpose |
|---|---|---|
| `GET /v1/addons` | — | List installed addons (includes `health`) |
| `GET /v1/addons/:id` | — | One addon (+ full manifest) |
| `DELETE /v1/addons/:id` | — | Uninstall |
| `PATCH /v1/addons/:id` | `{ enabled?, timeoutMs? }` | Toggle / retune |
| `POST /v1/addons/reorder` | `{ order: string[] }` | Set waterfall order |
| `POST /v1/addons/:id/refresh` | — | Re-fetch manifest |
| `POST /v1/addons/health/check` | — | Run a health sweep now |
| `POST /v1/addons/import/url` | `{ url }` or `{ urls: [] }` | Import by URL |
| `POST /v1/addons/import/stremio` | `{ email, password }` or `{ authKey }` | Import collection |
| `POST /v1/addons/import/repository` | `{ url }` | Import from a list |
| `GET /v1/settings` | — | Public debrid status (key masked) |
| `PATCH /v1/settings/debrid` | `{ provider?, apiKey? }` | Save debrid (409 if env-locked) |
| `POST /v1/settings/debrid/check` | — | Validate debrid credentials |

---

## Self-hosting on AWS EC2 (avoiding IP blocks)

Datacenter IPs are frequently blocked (403/429) by addon backends and stream
CDNs. Configure a residential (or other) HTTP proxy and `addons-core` routes
outbound requests through it:

```env
PROXY_URL=http://user:pass@residential-proxy:port
SCRAPE_PROXY_MODE=all        # addon hosts are arbitrary → proxy everything
SCRAPE_PROXY_STREAM=true     # also route /v1/proxy stream fetches through it
```

Control-plane hosts (`api.themoviedb.org`, `api.strem.io`) are never proxied, so
you don't waste metered residential bandwidth on them. Set `SCRAPE_PROXY_MODE=off`
(or leave `PROXY_URL` empty) to disable.

Also set `PUBLIC_URL=https://addons.yourdomain.tld` behind a reverse proxy so the
`/v1/proxy` URLs handed to the browser are absolute and reachable.

### Docker

```bash
docker compose up -d --build     # reads TMDB_API_KEY from your environment/.env
```

Installed addons (and debrid settings when stored) persist in the `addons-data`
volume (`/data/addons.json`). Pass `DEBRID_PROVIDER` / `DEBRID_API_KEY` via
compose env if you want env-locked debrid in the container.

---

## Configuration

See [`.env.example`](./.env.example) for every option. Highlights:

| Var | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `3006` / `localhost` | Use `0.0.0.0` for EC2/LAN |
| `PUBLIC_URL` | — | Absolute base for proxy URLs (reverse proxy) |
| `TMDB_API_KEY` | — | **Required** (resolves IMDb ids for addons) |
| `CACHE_TYPE` | `memory` | `memory` \| `redis` |
| `ADDONS_STORE` | `file` | `file` \| `redis` (redis needs `npm i redis`) |
| `ADDONS_DATA_FILE` | `./data/addons.json` | JSON persistence path |
| `ADMIN_ENABLED` | `true` | Serve `/admin` |
| `ADMIN_TOKEN` | — | Require token for management/import/settings |
| `PROXY_URL` | — | Residential egress proxy |
| `SCRAPE_PROXY_MODE` | `all` | `all` \| `allowlist` \| `off` |
| `SCRAPE_PROXY_STREAM` | `true` | Proxy `/v1/proxy` stream fetches too |
| `DEBRID_PROVIDER` | `none` | `none` \| `realdebrid` \| `alldebrid` \| `premiumize` |
| `DEBRID_API_KEY` | — | Debrid API key (env locks admin UI) |
| `ADDON_HEALTH_INTERVAL_MINUTES` | `15` | Background health interval (`0` = off) |
| `ADDON_AUTO_REFRESH` | `false` | Re-fetch manifests on each health sweep |
| `STREMIO_ADDON` | `false` | Expose this backend as a native Stremio addon |

---

## Architecture

```
CINEFLIX frontend ──serverUrl──▶ addons-core (OMSS / @omss/framework)
                                   ├─ /v1/providers            (installed addons)
                                   ├─ /v1/.../providers/:id     (progressive scrape)
                                   ├─ /v1/proxy                 (stream/subtitle proxy)
                                   ├─ /v1/settings*             (debrid status/config)
                                   └─ /v1/addons* + /admin       (management)
                                          │
                                   AddonManager ── registry.register() per enabled addon
                                          │
                                   StremioAddonProvider ──▶ {addon}/stream/{type}/{id}.json
                                          │                    (via residential egress)
                                   mapper → direct HTTP sources
                                   debrid → infoHash → HTTP (cached torrents only)
                                          │
                                   HealthMonitor ── periodic manifest pings
```

| Path | Role |
|---|---|
| `src/stremio/` | Stremio Addon Protocol client, provider, id + response mapping |
| `src/debrid/` | Magnet helpers, Real-Debrid / AllDebrid / Premiumize resolvers, service + torrent→source bridge |
| `src/health/` | Background health monitor + optional manifest auto-refresh |
| `src/addons/` | Manager (source of truth) + JSON/Redis persistence (addons + settings) |
| `src/import/` | URL, Stremio account, and repository importers |
| `src/egress/` | Residential proxy egress + optional global stream routing |
| `src/routes/` | Management, import, settings, and health REST API |
| `public/admin/` | Web admin UI (drag-reorder, debrid panel, health badges) |
| `test/` | Zero-dep unit tests for pure modules |

---

## Development

```bash
npm run dev          # tsx watch
npm run build        # tsc → dist/
npm start            # build + run dist/server.js
npm test             # build + node --test test/*.test.js  (33 tests)
npm run format       # prettier
```

---

## Roadmap (Phase 3+)

- Catalog / meta passthrough (browse addon catalogs from the admin or API).
- Wyzie (or other) subtitle fallback when addons don't supply them.
- Richer debrid: uncached-torrent wait/poll, multi-file picker UI.
- Multi-backend aggregation in the CINEFLIX frontend (run cineflix-core +
  addons-core side-by-side without switching `serverUrl`).

---

## License

[MIT](./LICENSE). Independent project. Built on the public `@omss/framework`.
Not affiliated with Stremio.
