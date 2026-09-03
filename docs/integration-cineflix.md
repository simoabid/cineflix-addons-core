# CINEFLIX frontend integration

How the CINEFLIX frontend consumes `addons-core` (the OMSS contract), and the
request flow for each UX.

## Pointing the frontend at this backend

Set the CINEFLIX server URL (`VITE_CINEPRO_URL` in the frontend) to this
service's public origin:

```sh
VITE_CINEPRO_URL=https://addons.example.tld
```

CORS must allow the frontend origin exactly (`CORS_ORIGIN=https://app.example.tld`,
comma-separated list for multiple origins). The wildcard is refused in
production.

## The waterfall (primary path)

The frontend queries providers **one by one**, best-first, so playback can
start before every addon has answered:

```
GET /v1/providers                          → ordered provider list (ETag / x-provider-revision)
GET /v1/movies/:tmdbId/providers/:providerId
GET /v1/tv/:tmdbId/seasons/:s/episodes/:e/providers/:providerId
```

- The order is the operator's configured addon order (one ordering model for
  progressive and bulk paths). Circuit-open, quarantined, budget-exhausted,
  and non-stream-capable providers are excluded automatically.
- Each response contains `sources[]` with playable URLs (playback grants when
  `SECURE_PROXY=true`), plus `revision` for cache coherence.
- The frontend stops querying when it has enough playable sources; remaining
  providers are not penalized.

## Aggregate path (batch UX)

When the frontend wants *all* sources up front (e.g. a sources list page):

```
GET /v1/movies/:id            → all eligible providers, cached, priority-ordered
```

Same selection policy as the waterfall, bounded by
`BULK_MAX_PROVIDERS_PER_REQUEST` and `SOURCE_LOOKUP_DEADLINE_MS`.

## Subtitles

```
GET /v1/subtitles?tmdbId=&season=&episode=&language=
```

Aggregates all subtitle-capable addons; responses carry playback-grant URLs
when secure proxy is on.

## Caching & coherence

- Frontends may cache responses; treat `x-provider-revision` /
  `ETag: "rev-<n>"` as the coherence token. Any provider mutation (install,
  remove, reorder, enable/disable, timeout) bumps the revision; cached
  responses under an old revision are stale by definition.
- Server-side caches are revision-aware and cluster-invalidated
  (`CLUSTER_BUS_ENABLED` with Redis) — the frontend never needs to know.

## Playback

`sources[].url` values point at this backend (`/v1/proxy/grant/:id`) and are:

- short-lived (`PLAYBACK_GRANT_TTL_SEC`) and single-use-capable;
- Range-request aware (seek works);
- subject to per-IP/user/global concurrency caps
  (`MAX_CONCURRENT_STREAMS_*`) — `429` with `Retry-After` when exceeded;
- proxied with SSRF-validated, redirect-revalidated upstream fetches.

Fetch the source URL right before playback; do not persist source URLs —
grants expire by design.

## Example end-to-end

```sh
# 1. provider order
curl -s https://addons.example.tld/v1/providers | jq -r '.[].id'
# 2. waterfall, first provider
curl -s "https://addons.example.tld/v1/movies/27205/providers/addon%3Aorg-slug" | jq '.sources[0].url'
# 3. play (Range supported)
curl -s -H 'Range: bytes=0-1023' -o /dev/null -w '%{http_code}\n' "$SOURCE_URL"   # 206
```

Error handling: `429` (rate limit — back off), `403` (expired/invalid grant —
re-query the provider), `503` (readiness drain during deploys — retry with
backoff). Full codes: [docs/api-reference.md](api-reference.md).
