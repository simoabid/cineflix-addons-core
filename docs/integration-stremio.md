# Native Stremio integration

`addons-core` can re-expose **itself** as a Stremio addon, so a plain Stremio
client can use the aggregation pipeline directly — no CINEFLIX frontend
required.

## Enabling

```sh
STREMIO_ADDON=true   # .env — exposes /stremio/manifest.json + /stremio/stream/:type/:id
```

This is a distinct surface from the installed addons' own routes:

| Surface | Routes | Purpose |
|---|---|---|
| Installed addons | proxied via `/v1/proxy/grant/:id` and the management API | addons-core is the *consumer* of other addons |
| Native re-exposure | `/stremio/manifest.json`, `/stremio/stream/:type/:id` | addons-core *acts as* a Stremio addon, aggregating its providers |

## Install into a Stremio client

1. Expose the service over HTTPS (`PUBLIC_URL`).
2. In Stremio: *Addons → Community Addons → URL* and enter
   `https://addons.example.tld/stremio/manifest.json`.
3. Streams returned follow the Stremio stream protocol; playable URLs are
   playback-grant proxies or debrid-resolved direct links, depending on the
   source.

## Behavior notes

- The native manifest advertises stream capability for movie/series; catalog
  and meta passthrough is a planned expansion (Phase 12 §15.1) and is not part
  of the native surface.
- Stream responses are computed through the same aggregated pipeline as
  `GET /v1/movies/:id` — same provider selection, same circuits and budgets.
- Client identification: Stremio sends its own user agent; per-IP rate limits
  and concurrent-stream caps apply like any other caller
  (`ANON_SCRAPE_RATE_LIMIT_PER_MIN`, `MAX_CONCURRENT_STREAMS_PER_IP`).
- Playback grants are bound to short TTLs; Stremio will re-request streams as
  needed — grant issuance is cheap and capped
  (`PLAYBACK_GRANT_MAX_ACTIVE`, `PLAYBACK_GRANT_MAX_PER_REQUEST`).

## CINEFLIX vs Stremio integration

See [docs/integration-cineflix.md](integration-cineflix.md) for the frontend
waterfall contract. Both integrations share one pipeline; they differ only in
how results are consumed (OMSS JSON vs Stremio stream protocol).
