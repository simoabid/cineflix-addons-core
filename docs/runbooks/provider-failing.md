# Runbook 01: Provider Failing / Circuit Breaker Trips

## 1. Metadata
- **Severity**: High (if provider ratio < 50%) / Medium (single non-critical provider)
- **Trigger**: Prometheus metric `addons_core_provider_failure_ratio > 0.40` or health check returning `PROVIDERS_DEGRADED` / `CIRCUIT_BREAKER_OPEN`.
- **Affected Components**: `AddonManager`, `CircuitBreaker`, `ProviderSelectionService`, Upstream Stremio Addons.
- **Blast Radius**: Scrape latency increases, stream availability drops for media types served by this provider.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check Service Status and Provider Health
```bash
curl -s http://localhost:7000/health/status | jq .
```
Look for `incidents` array containing `PROVIDERS_DEGRADED` or `STALE_PROVIDER_HEALTH`.

### Step 2.2: Inspect Problematic Provider Circuit & Metrics
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/debug/providers/<providerId> | jq .
```
Verify:
- `reliability.state`: Is it `open`, `half_open`, or `closed`?
- `reliability.metrics.consecutiveFailures`: How many consecutive failures?
- `reliability.metrics.failureClassification`: What is the dominant failure kind (e.g. `timeout`, `network_error`, `http_5xx`, `blocked`)?

### Step 2.3: Query Recent Provider Error Traces
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:7000/debug/traces?hasError=true&limit=20" | jq .
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Force Immediate Circuit Reset (Transient Glitch Recovered)
If the upstream addon has recovered and you want to bypass the half-open cooldown:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/test-provider \
  -H "Content-Type: application/json" \
  -d '{"providerId": "<providerId>"}' | jq .
```

### Option B: Increase Provider Timeout
If the provider is slow due to heavy upstream load:
```bash
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/<providerId> \
  -H "Content-Type: application/json" \
  -d '{"timeoutMs": 15000}' | jq .
```

### Option C: Temporarily Disable Problematic Provider
If the upstream addon is suffering an extended outage and slowing down waterfall scrapes:
```bash
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/<providerId> \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' | jq .
```

### Option D: Re-order Provider Priority
Move the failing provider to the bottom of the priority order so fast healthy providers respond first:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/reorder \
  -H "Content-Type: application/json" \
  -d '{"order": ["healthy-addon-1", "healthy-addon-2", "<failing-addon>"]}' | jq .
```

---

## 4. Verification & Validation

1. **Verify Health Endpoint**:
   ```bash
   curl -s http://localhost:7000/health/status | jq '{status: .status, usableRatio: .details.streamProviders.usableRatio, incidents: .incidents}'
   ```
   Confirm `status` is `ok` and `usableRatio >= 0.50`.

2. **Verify Scrape Route**:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/<providerId> | jq .
   ```

---

## 5. Post-Incident Review & RCA
- Record upstream outage duration and root cause in incident log.
- If the provider frequently fails, consider decommissioning it or configuring a dedicated egress proxy.
