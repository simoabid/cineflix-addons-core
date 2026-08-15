# ADR 0004 — Phase 7: operational resilience and scale

- **Status:** Accepted
- **Date:** 2026-08-15
- **Context:** Production readiness plan §10 (Phase 7 — Operational resilience
  and scale)

## Decision

Phase 7 makes `addons-core` safe to operate under real traffic, rolling
deploys, and multi-instance production by bounding all concurrency, draining
gracefully on termination, coordinating replicas explicitly, and applying
capacity/cost controls.

### 1. Bounded concurrency (§10.1)

- New `src/concurrency/` module: a `WeightedSemaphore` (weight units,
  priority queue, queue depth cap, queue timeout, abort signals) and a
  `ConcurrencyCoordinator` holding one pool per class of remote work:
  `bulk-scrape`, `progressive-scrape`, `provider-stream`, `outbound-host`,
  `subtitles`, `manifest`, `health`, `debrid`, `proxy-stream`,
  `hls-segment`.
- Separate pools (rather than one shared pool) are the primary starvation
  defense: bulk traffic can saturate its own pool but can never consume
  capacity reserved for health checks or playback. Bulk acquisitions are
  additionally *weighted* by provider fan-out.
- `scrapeFetch` is the single choke point for the `outbound-host` class:
  `secureFetch` (and therefore manifests, imports, streams, and proxy
  upstreams) delegates through it, so per-host caps apply to all egress.
- Saturation fails fast: inbound routes answer `503 OVERLOADED` with
  `Retry-After`; queued acquisitions time out (`CONCURRENCY_QUEUE_TIMEOUT_MS`)
  instead of piling up.
- All limits are env-configurable (`CONCURRENCY_*`), centralized in
  `src/config.ts`.

### 2. Graceful shutdown & rolling deploys (§10.2)

- New `src/lifecycle/`: `ReadinessGate` (process-wide) + `ShutdownCoordinator`
  (ordered phases, each under its own timeout, all bounded by
  `TERMINATION_GRACE_PERIOD_MS`). Signals: first SIGTERM/SIGINT begins the
  sequence; a second force-exits.
- Sequence: flip readiness false (`/health/ready` → 503 with a
  `shutting_down` check) → refuse new non-probe requests with 503 +
  `Connection: close` → stop background schedulers → drain jobs → abort
  queued pool waiters → close HTTP listener → close cluster bus → cache →
  storage → egress agents → exit.
- Job drain semantics: `JobEngine.beginShutdown(drainMs)` lets in-flight jobs
  finish; stragglers are released back to the queue with a *retryable*
  failure (`WORKER_SHUTDOWN`) rather than cancelled, so another replica (or
  a restart) retries them. Progress/heartbeat records act as checkpoints;
  leases expire via `lockedUntil`.
- Orchestration: set `terminationGracePeriodSeconds` (K8s) /
  `stop_grace_period` (compose) ≥ `TERMINATION_GRACE_PERIOD_MS`. See
  `docs/runbooks/graceful-shutdown-rolling-deploy.md`.

### 3. Explicit multi-instance behavior (§10.3)

- New `src/cluster/ClusterBus`: Redis pub/sub channel carrying `revision`
  and `cache-invalidate` events. On a foreign revision bump, replicas reload
  configuration from shared storage via `AddonManager.reloadFromStorage()`
  (no-op unless the stored revision is newer) and drop caches. Without Redis
  the bus is a no-op (single-instance dev/test).
- Shared durable state (already enforced): addons/health/audit/jobs/grants
  live in Postgres/Redis; production refuses to start without Redis
  (assertProductionSafe, Phase 1) so playback grants work on any replica.
- Distributed locks: scheduled maintenance + health sweeps enqueue under
  `DistributedLockService` locks (on top of storage-level dedup keys);
  Postgres migrations run under a session-level advisory lock.
- **Explicitly best-effort process-local state** (documented, per-instance):
  circuit breakers + quarantine, debrid link cache, in-memory rate-limit
  buckets, provider daily budget counters, egress byte accounting. Correctness
  (auth, grants, configuration, jobs) never depends on them; they only become
  more conservative when replicated.

### 4. Capacity & cost controls (§10.4)

- **Stream concurrency caps** (`StreamConcurrencyTracker`): per IP, per
  authenticated user, and global caps on concurrent proxied streams;
  Redis-shared counters with TTL safety when available, memory fallback.
  Rejections are `429` with `Retry-After`.
- **Source-lookup cost cap**: `BULK_MAX_PROVIDERS_PER_REQUEST` truncates the
  priority-ordered provider list per bulk request; the aggregation deadline
  is configurable (`SOURCE_LOOKUP_DEADLINE_MS`).
- **Grant issuance caps**: hard cap on active grants (issue rejects once
  reached, after purging expired) and per-request cap on child grants minted
  by a single manifest rewrite (remaining URLs keep their upstream form).
- **Per-provider daily call budgets** (`ProviderBudgetRegistry`): UTC-day
  windows, per-provider overrides, enforced at the provider call site and
  filtered in selection; exhaustion surfaces in diagnostics and metrics.
- **Egress budget alerts** (`EgressBudgetMonitor`): daily total and
  residential-proxy byte budgets with warn/exceed levels surfaced as
  structured logs, `/health/status` incidents, and Prometheus gauges.
- **Anonymous quotas**: separate configurable scrape quota for unauthenticated
  callers (`ANON_SCRAPE_RATE_LIMIT_PER_MIN`) plus configurable proxy
  redemption quota.
- **Provider quarantine**: providers whose circuit opens
  `QUARANTINE_OPEN_THRESHOLD` times within `QUARANTINE_WINDOW_MS` are
  quarantined (excluded from selection and provider calls) until TTL expiry
  or manual release via `POST /v1/quarantine/:providerId/release` (admin,
  audited). Surfaced in `/v1/providers`, `/v1/providers/diagnostics`,
  `/debug/providers/:id`, `/health/status`, and metrics.

## Consequences

- Every class of remote work now has an explicit, configurable bound, and
  saturation is observable (`addons_concurrency_*` metrics) and fail-fast
  rather than latent.
- Rolling deploys drain requests and jobs; no request or job is dropped on a
  normal restart, and the orchestrator always wins (double-signal force
  exit).
- Multi-instance deployments converge configuration within one pub/sub hop;
  remaining process-local state is enumerated as best-effort rather than
  accidental.
- Cost-sensitive knobs (stream caps, budgets, quotas, grant caps) default to
  safe values and are documented in `.env.example`.
