# Observability guide

Dashboards, metrics, traces, health semantics, and the alert set for
operating `addons-core`. Incident response steps live in
[docs/runbooks/](runbooks/).

## Health endpoints (probe design)

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /health/live` | Process/event-loop alive | Liveness probe, container HEALTHCHECK |
| `GET /health/ready` | Storage + cache + jobs ready to serve | Readiness probe; flips false during shutdown drain |
| `GET /health/status` | Full incident status (200 or 503 with codes) | Dashboards, humans |
| `GET /health/dependencies` | Storage, cache, TMDB, debrid detail | Diagnostics |

Readiness represents actual ability to serve — not process existence. During
graceful shutdown it returns `503` while in-flight work drains
(`TERMINATION_GRACE_PERIOD_MS`).

## Metrics

`GET /metrics` (Prometheus format; keep it behind auth). Key series:

| Series | Alert signal |
|---|---|
| `addons_core_provider_failure_ratio` / circuit state | > 0.4 or `open` → [runbook 01](runbooks/provider-failing.md) |
| `addons_core_debrid_errors_total` (by kind, incl. `AUTH_FAILURE`) | > 5 → [runbook 03](runbooks/debrid-outage.md) |
| `addons_core_proxy_denied_ssrf_total` | Rising → [runbook 10](runbooks/ssrf-security-incident.md) |
| `addons_core_proxy_egress_bytes_total` | Spike → [runbook 07](runbooks/high-proxy-egress.md) |
| HTTP request duration/histogram per route | p95 regression vs [perf baseline](../scripts/perf/load.js) |
| Concurrent streams (per-IP/user/global gauges) | Saturation → capacity review |
| Queue depth / rejections per concurrency pool | Sustained rejections → raise pool or investigate upstream |
| Job dead-letter count | > 0 → [runbook 06](runbooks/stuck-jobs.md) |
| Storage/cache backend errors | > 0 → [runbook 05](runbooks/storage-cache-outage.md) |

The detailed thresholds and the incident triage matrix are in
[docs/runbooks/INDEX.md](runbooks/INDEX.md).

## Traces

W3C trace propagation is supported end-to-end: send
`traceparent: 00-<trace>-<span>-01` and the server joins your trace; responses
return `x-trace-id`. Inspect errors via the admin API:
`GET /debug/traces?hasError=true`. Every request log line is structured JSON
with `requestId`, route, status, duration, and redacted upstream metadata.

## Suggested dashboard panels

1. **Traffic** — req/s by route family; waterfall vs aggregate vs proxy bytes.
2. **Waterfall quality** — per-provider success ratio, latency p50/p95,
   circuit states, quarantine list size.
3. **Playback** — active streams vs caps, proxy egress bytes (total + proxy),
   grant issues/rejections, `429` rate.
4. **Jobs** — queue depth, running/dead-letter, import job durations.
5. **Dependencies** — TMDB latency/errors, debrid latency/errors, redis/pg
   health.
6. **Cost** — egress budget burn-down (daily), provider call budgets
   remaining.

## Log redaction

All log/trace/audit output passes through redaction (`redactString`,
`redactUrl`): tokens, debrid keys, and secret-bearing URL components never
appear. If you forward logs, keep that guarantee — do not log raw request URLs
on management routes at the edge.
