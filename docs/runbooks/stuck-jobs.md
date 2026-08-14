# Runbook 06: Stuck Background Jobs & Lease Expiry

## 1. Metadata
- **Severity**: Medium
- **Trigger**: Jobs stuck in `running` state past lease timeout, dead-letter queue growth (`addons_core_jobs_total{status="dead_letter"} > 0`), or import tasks hanging.
- **Affected Components**: `JobEngine`, `DistributedLockService`, Storage Job Handlers.
- **Blast Radius**: Background addon imports, manifest refreshes, and maintenance sweeps stall.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: List Active and Failed Jobs
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:7000/api/addons/admin/jobs?status=running" | jq .
```
And check dead-lettered jobs:
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:7000/api/addons/admin/jobs?status=dead_letter" | jq .
```

### Step 2.2: Check Job Engine Metrics
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/metrics | grep "addons_core_jobs"
```

### Step 2.3: Check Worker Heartbeats in Logs
```bash
journalctl -u addons-core -n 100 | grep -E "(heartbeatJob|executeJob|lockDuration)"
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Cancel Stuck Job Cooperatively
Cancel a running job by its ID:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:7000/api/addons/admin/jobs/<jobId>/cancel" | jq .
```

### Option B: Force Automatic Re-acquisition of Expired Leases
The `JobEngine` automatically reclaims jobs whose lease (`lockedUntil`) has expired and `attempts < maxAttempts`.
To trigger an immediate maintenance cleanup sweep:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/sweep-health | jq .
```

### Option C: Re-enqueue or Retry Dead-Lettered Job
If a dead-lettered import failed due to transient network issues:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:7000/api/addons/admin/jobs/<jobId>/retry" | jq .
```

### Option D: Purge Stale / Poison Jobs
If an unparseable addon URL is repeatedly crashing worker handlers:
```bash
curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:7000/api/addons/admin/jobs/<jobId>" | jq .
```

---

## 4. Verification & Validation

1. **Verify No Stuck Running Jobs**:
   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     "http://localhost:7000/api/addons/admin/jobs?status=running" | jq '.jobs | length'
   # Expected: <= JOB_WORKER_CONCURRENCY
   ```

2. **Verify Job Worker Pool Stats in Health**:
   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/health/dependencies | jq '.dependencies[] | select(.name=="JobEngine")'
   ```

---

## 5. Post-Incident Review & RCA
- Inspect worker logs for uncaught exceptions that bypassed `executeJob` try/catch.
- Increase `jobLockDurationMs` if large multi-addon imports legitimately take longer than 60s.
