# Concepts — how the service behaves

The exact difference between the terms used across this documentation and the
API. Reading this once prevents most integration misunderstandings.

## Bulk aggregation — `GET /v1/movies/:id`

A **batch** lookup: the server queries *every eligible provider* (up to
`BULK_MAX_PROVIDERS_PER_REQUEST`) with bounded concurrency, merges and
deduplicates all sources, caches the merged response, and returns everything
at once. Use when a UI shows a complete source list. Cost: one request fans
out to many upstreams — bounded by `SOURCE_LOOKUP_DEADLINE_MS` and the
`bulk-scrape` pool. Eligibility, ordering, and circuits are decided by the
single `ProviderSelectionService`.

## Progressive waterfall scraping — `GET /v1/movies/:id/providers/:providerId`

A **single-provider** lookup for one title. The frontend calls providers in
priority order until it has enough playable sources, so playback starts as
soon as the first good addon answers instead of waiting for everyone. Same
selection policy, same caches, one provider per call — that is the whole
difference from bulk. Ordering changes affect both paths identically (one
ordering model, revision-invalidated).

## Subtitle aggregation — `GET /v1/subtitles`

A separate fan-out restricted to **subtitle-capable** addons (capability
model), merging subtitle tracks across providers. Independent of the stream
waterfall: a catalog-only addon that also serves subtitles participates here
but never in stream lookups.

## Provider manifest health

A **per-addon upstream signal**: the background health monitor probes each
installed addon's manifest on an interval and records reachability/freshness.
It drives provider filtering (unhealthy providers are skipped by the selection
service), circuit breaking (repeated failures open a circuit; repeated opens
trigger auto-quarantine), and diagnostics (`/debug/providers/:id`).
Health is *not* the service's own status — see readiness.

## Service readiness — `GET /health/ready`

The **service's own** ability to serve requests right now: storage, cache,
and job infrastructure ready. Readiness says nothing about upstream addon
health (that is the per-provider health above) and liveness
(`/health/live`) says nothing beyond "the event loop runs". Orchestrators:
liveness for restarts, readiness for traffic.

## Native Stremio re-exposure — `/stremio/manifest.json`

The service presenting **itself** as a Stremio addon so plain Stremio clients
consume the aggregation. Same pipeline as the OMSS routes, different protocol
surface. See [docs/integration-stremio.md](integration-stremio.md).

## Direct streams vs debrid-resolved streams

- **Direct streams** — the addon returned a playable HTTP URL (an mp4/HLS
  link). Wrapped in a playback grant, proxied with Range support. Playable
  with no external account.
- **Debrid-resolved streams** — the addon returned a **torrent**
  (`infoHash`); a configured debrid provider (Real-Debrid / AllDebrid /
  Premiumize) resolves it to a direct HTTP link when a cached copy exists.
  Costs a debrid account; subject to provider cache availability and limits.
- Torrent sources **without** debrid configured are not playable; they appear
  with diagnostics rather than dead links. The two kinds are distinguishable
  in source metadata so frontends can label them
  ([docs/debrid.md](debrid.md)).

## Provider revision — `x-provider-revision`

The coherence token for everything above. Install/remove/reorder/enable/
timeout changes bump a monotonically increasing revision; server caches are
revision-keyed, and cluster replicas are invalidated via the Redis bus
(`CLUSTER_BUS_ENABLED`). Clients treat responses from an older revision as
stale.

## Capability model

Each addon's manifest is decomposed into independent capabilities: `stream`
(per media type and id-prefix), `subtitles`, catalog, meta. The waterfall
only ever includes stream-capable providers matching the requested type and
id prefix; catalog/meta-only addons are registered and visible but excluded
from stream lookups ([docs/addon-admission.md](addon-admission.md)).
