# Addon admission and troubleshooting

How addons get into `addons-core`, what "admitted" means, and how to debug
one that misbehaves.

## Admission paths

| Path | Endpoint | Notes |
|---|---|---|
| Manifest URL | `POST /v1/addons/import/url` | Validated against the Stremio manifest schema; SSRF policy applies (loopback/private refused regardless of environment — defense in depth). |
| Stremio account | `POST /v1/addons/import/stremio` | Logs into the account API and imports the collection; credentials are used once, never stored. |
| Repository list | `POST /v1/addons/import/repository` | Batch import from an addon repository listing, bounded by `IMPORT_MAX_URLS` / `IMPORT_MAX_CONCURRENT`. |
| Boot seed | `ADDONS_SEED_URLS` env | Installed once at first boot (also the hermetic path for tests). |

Imports are background jobs (`/v1/import/jobs`) with bounded size
(`IMPORT_MAX_BYTES`), timeouts, and concurrency; large repository imports are
queued rather than blocking the request.

## What happens on admission

1. **Manifest validation** — schema, resource declarations, catalog/type
   prefixes.
2. **Capability derivation** (`src/capabilities`) — what the addon can serve:
   `stream` (per media type + id prefixes), `subtitles`, catalog, meta.
   Addons that cannot provide streams are **never** admitted into the stream
   waterfall — they serve catalogs/metadata only and never receive progressive
   source lookups.
3. **Provider registration** — one `addon:<slug>` provider in `/v1/providers`,
   with priority (ordering), timeout (`timeoutMs`), and a revision bump that
   invalidates caches cluster-wide.
4. **Health tracking** — a background monitor probes manifests on an interval
   and records per-provider health.

## Troubleshooting an addon

```sh
# 1. Is it installed and enabled?
curl -sH "x-admin-token: $TOKEN" https://addons.example.tld/v1/addons | jq '.[] | {id, enabled, health, capabilities}'

# 2. Does it appear as a stream provider for a given title?
curl -s https://addons.example.tld/v1/providers | jq '.[] | .id'

# 3. Ask just this provider for sources (the exact waterfall call)
curl -s "https://addons.example.tld/v1/movies/27205/providers/addon%3Aorg-slug" | jq

# 4. Detailed provider debug: circuit state, consecutive errors, classification
curl -sH "x-admin-token: $TOKEN" https://addons.example.tld/debug/providers/addon%3Aorg-slug | jq

# 5. Force a manifest refresh / health probe
curl -X POST -H "x-admin-token: $TOKEN" https://addons.example.tld/v1/addons/addon%3Aorg-slug/refresh
curl -X POST -H "x-admin-token: $TOKEN" https://addons.example.tld/v1/addons/health/check
```

Common findings:

| Symptom | Likely cause | Fix |
|---|---|---|
| In `/v1/addons` but not in waterfall | Not stream-capable for that type/id prefix (capability model) | Expected behavior — check `capabilities.stream[].idPrefixes` and media types |
| `circuit open` in `/debug/providers` | Repeated upstream failures | Inspect the upstream; it auto-closes after a cool-down, or [runbook 01](runbooks/provider-failing.md) |
| `quarantined` | Auto-quarantine after repeated circuit opens | `GET /v1/quarantine`, release via `POST /v1/quarantine/:id/release` ([runbook 11](runbooks/emergency-quarantine-addon.md)) |
| Sources but not playable | Torrent without debrid, or dead direct link | [docs/debrid.md](debrid.md); grant TTL vs provider link TTL |
| Manifest fetch fails | Upstream blocks the server IP | [docs/egress-proxy.md](egress-proxy.md) |
| Import rejected (loopback/private host) | SSRF policy | Expected — imports must use public https manifests |

## Ordering

Provider order drives both the progressive waterfall and bulk aggregation
(one ordering model — `POST /v1/addons/reorder`). Reordering bumps the
revision, invalidating caches across instances.
