# Runbook 13: Graceful Shutdown & Rolling Deploy Verification

## 1. Metadata
- **Severity**: Standard Ops
- **Trigger**: Deployments, scale-in events, node drains, or any SIGTERM/SIGINT
  delivered to an `addons-core` replica. Also: `addons_shutting_down` gauge at 1,
  503 `SHUTTING_DOWN` responses, or jobs failing with `WORKER_SHUTDOWN`.
- **Affected Components**: `ShutdownCoordinator`, `ReadinessGate`, `JobEngine`
  drain, `ClusterBus`, CacheManager, storage backends, egress agents.
- **Blast Radius**: One replica at a time (rolling). Misconfigured grace
  periods cause dropped requests or killed jobs.

---

## 2. Shutdown Sequence (what normally happens)

On the first `SIGTERM`/`SIGINT`, phases run in order, each time-bounded, all
within `TERMINATION_GRACE_PERIOD_MS` (default 15 s):

1. **Readiness flips false** — `/health/ready` returns 503 with
   `checks.shutdown.message`; the LB should drain the pod.
2. **New work refused** — non-probe requests get `503 SHUTTING_DOWN` with
   `Connection: close` and `Retry-After: 5`. `/health/*` and `/metrics` keep
   answering.
3. **Background schedulers stop** — health monitor timers halt.
4. **Jobs drain** — in-flight jobs get ~60% of the grace period to finish;
   stragglers are released to the queue with a retryable
   `Job interrupted by worker shutdown` failure so another replica retries
   them (set `SHUTDOWN_DRAIN_JOBS=false` to abort immediately instead).
5. **Queued pool waiters abort** — requests waiting on saturated concurrency
   pools get an AbortError instead of hanging the event loop.
6. **Close order**: HTTP listener → cluster bus → cache (Redis) → storage →
   egress proxy agents → `process.exit(0)`.

A **second** signal force-exits immediately (exit 130) — the orchestrator
always wins.

---

## 3. Procedure: Verify Before / During a Rolling Deploy

### Step 3.1: Confirm grace periods line up
```bash
# In-app budget (ms):
grep TERMINATION_GRACE_PERIOD_MS .env
```
- Kubernetes: `terminationGracePeriodSeconds` must be **>=** the in-app value
  (ideally +5 s headroom).
- Docker/compose: `stop_grace_period` must be **>=** the in-app value.

### Step 3.2: Watch readiness flip during a deploy
```bash
while true; do
  curl -s -o /dev/null -w '%{http_code}\n' https://addons.example.tld/health/ready
  sleep 1
done
```
Expected: 200 → (one replica) 503 → 200. The 503 body contains
`"shuttingDown": true`-driven check output:
```bash
curl -s https://addons.example.tld/health/ready | jq '.checks.shutdown'
```

### Step 3.3: Confirm no dropped jobs
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  'http://localhost:3006/v1/jobs?limit=50' | jq '[.jobs[] | select(.error != null)]'
```
Jobs interrupted by shutdown appear with
`Job interrupted by worker shutdown; released for retry` and must transition
`queued → running → completed` on another replica.

### Step 3.4: Confirm clean exit in logs
The final lifecycle line must be:
```
Shutdown complete in <N>ms (<ok>/<total> phases ok)
```
Any `Shutdown phase '...' failed: ...` line indicates a stuck dependency —
capture it before the pod recycles.

---

## 4. Diagnosis: Shutdown Problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Process exits 143/137 immediately | Orchestrator grace < in-app grace, or double signal | Raise `terminationGracePeriodSeconds` / `stop_grace_period` |
| `close-http-listener` phase times out | Long-lived streaming responses outliving the grace period | Raise `TERMINATION_GRACE_PERIOD_MS`, or shorten `PLAYBACK_GRANT_TTL_SEC` / stream caps |
| `drain-jobs` phase times out repeatedly | A job handler ignores its AbortSignal | Fix the handler to honor `ctx.signal`; interim: `SHUTDOWN_DRAIN_JOBS=false` |
| Jobs land in `dead_letter` after deploys | Attempts exhausted across repeated restarts | `POST /v1/jobs/:id/retry` after the deploy settles |
| Replica stays in LB during shutdown | LB drains on liveness instead of readiness | Point the LB pool at `/health/ready` |
| Config changes not visible on other replicas | Cluster bus disabled / Redis down (`cluster.mode` in `/health/status`) | Verify `CLUSTER_BUS_ENABLED=true` and Redis health; restart replicas to re-sync |

---

## 5. Verification
- [ ] `/health/ready` returns 503 (not connection reset) while shutting down.
- [ ] New API requests receive `503 SHUTTING_DOWN`; `/health/live` stays 200.
- [ ] In-flight jobs complete or are retried on another replica — no
      `cancelled` spikes during deploys.
- [ ] Process exits 0 with `Shutdown complete` in the logs.
- [ ] After the deploy, `/v1/providers` revision matches across replicas
      (`cluster.instanceId` differs, revision converges).
