# Architecture

System shape, module map, and the index of architecture decision records.

## System diagram

```text
                         ┌──────────────────────────────┐
                         │ Reverse proxy / TLS / WAF     │
                         │ auth boundary / rate limits   │
                         └──────────────┬───────────────┘
                                        │
                    ┌───────────────────▼───────────────────┐
                    │ addons-core API                         │
                    │ OMSS + management + admin              │
                    └───────┬───────────┬───────────┬────────┘
                            │           │           │
          ┌─────────────────▼─┐   ┌─────▼─────┐ ┌───▼────────────────┐
          │ Provider pipeline │   │ Job system │ │ Secure proxy/egress │
          │ ordered, bounded  │   │ import,    │ │ signed URLs,        │
          │ and cached        │   │ health,    │ │ SSRF controls       │
          └───────┬───────────┘   │ refresh    │ └─────────┬───────────┘
                  │               └─────┬─────┘           │
      ┌───────────▼────────────┐        │          ┌──────▼──────────┐
      │ Stremio/debrid adapters │        │          │ Outbound policy │
      │ per-provider isolation  │        │          │ proxy + DNS     │
      └───────────┬────────────┘        │          └─────────────────┘
                  │                      │
       ┌──────────▼──────────┐  ┌────────▼───────────────────┐
       │ Stremio/debrid APIs  │  │ Postgres + Redis + secrets │
       └─────────────────────┘  └────────────────────────────┘
```

Key invariants (see ADRs for the decisions behind them):

1. **Fail-closed production** — insecure configurations refuse to start.
2. **Capability-gated pipeline** — only stream-capable addons enter the
   waterfall; selection is centralized in `ProviderSelectionService`.
3. **One ordering/revision model** — provider order and revision drive
   progressive, bulk, and caches identically, cluster-wide.
4. **Every remote dependency is bounded** — pools, budgets, deadlines,
   circuit breakers, SSRF policy on every outbound URL.
5. **Secrets never appear in logs/audits/responses** — redaction everywhere;
   debrid keys encrypted at rest.

## Module map

| Module | Role |
|---|---|
| `src/config.ts` | All env config; fail-closed production validation |
| `src/server.ts` | Composition root; framework patching (TMDB, selection, cache revision) |
| `src/addons/` | `AddonManager` (source of truth), storage-backed stores |
| `src/storage/` | `IStorageBackend`: file (default), postgres (transactional + migrations), redis |
| `src/stremio/` | Addon protocol client, provider adapter, id mapping, URL normalization |
| `src/debrid/` | Magnet helpers, Real-Debrid/AllDebrid/Premiumize resolvers, torrent bridge |
| `src/capabilities/` | Manifest capability derivation (stream/subtitles/catalog/meta) |
| `src/providers/selection.ts` | Authoritative provider ordering/selection |
| `src/sources/` | Upstream URL normalization, dedup, bounded probes |
| `src/subtitles/` | Subtitle aggregation |
| `src/security/` | auth/RBAC, audit, CSRF, playback grants, proxy routes, rate limits, secrets, redaction, secureFetch, urlPolicy (SSRF) |
| `src/egress/` | Residential proxy egress + global stream dispatcher |
| `src/concurrency/` | Weighted semaphores and named pools |
| `src/capacity/` | Budgets and stream capacity guards |
| `src/reliability/` | Circuit breakers, retry classification, quarantine |
| `src/health/` | Background manifest health monitor |
| `src/jobs/` | Background job engine (locks, leases, dead letters) |
| `src/cluster/` | Redis pub/sub bus for revision + cache invalidation |
| `src/lifecycle/` | Readiness gate + graceful shutdown coordinator |
| `src/cache/`, `src/media/`, `src/telemetry/`, `src/metrics/`, `src/openapi/`, `src/validation/`, `src/import/`, `src/routes/`, `public/admin/` | Supporting subsystems |

## ADR index

| ADR | Decision |
|---|---|
| [0001](adr/0001-repository-ownership.md) | Repository ownership and boundaries (standalone nested repo) |
| [0002](adr/0002-phase-0-quality-gates.md) | Phase 0 quality gates (CI minimums) |
| [0003](adr/0003-phase-1-security-boundaries.md) | Security & trust boundaries (auth, SSRF, grants, redaction) |
| [0004](adr/0004-phase-7-operational-resilience.md) | Operational resilience (pools, budgets, shutdown, multi-instance) |
| [0005](adr/0005-phase-9-test-strategy.md) | Phase 9 test strategy and quality tooling |

New significant decisions are recorded as new ADRs following the same format.

## Related documentation

[concepts](concepts.md) · [installation](installation.md) ·
[configuration](configuration.md) · [security checklist](security-checklist.md) ·
[admin auth](admin-auth.md) · [reverse proxy](reverse-proxy.md) ·
[egress proxy](egress-proxy.md) · [debrid](debrid.md) ·
[addon admission](addon-admission.md) · [API reference](api-reference.md) ·
[CINEFLIX integration](integration-cineflix.md) ·
[Stremio integration](integration-stremio.md) ·
[observability](observability.md) · [backup/DR](backup-restore.md) ·
[supply chain](supply-chain.md) · [support policy](support-policy.md) ·
[runbooks](runbooks/)
