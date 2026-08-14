# Runbook 11: Emergency Addon Quarantine / Circuit Trip / Disablement

## 1. Metadata
- **Severity**: High / Medium
- **Trigger**: Rogue addon returning copyright traps, malicious URLs, spam streams, corrupting memory, or high crash rates.
- **Affected Components**: `AddonManager`, `CircuitBreaker`, `ProviderSelectionService`, Stream Aggregator.
- **Blast Radius**: Isolated to the affected addon; healthy addons continue serving traffic normally.

---

## 2. Initial Triage & Identification

### Step 2.1: Locate Addon ID and Current State
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:7000/api/addons | jq '.addons[] | {id: .providerId, name: .name, enabled: .enabled, order: .order}'
```

### Step 2.2: Check Provider Diagnostics
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/debug/providers/<addonId> | jq .
```

---

## 3. Step-by-Step Quarantine & Disablement

### Option A: Immediate Soft Disablement (Keep Config for Inspection)
Disable the addon so it is immediately removed from provider selection:
```bash
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/<addonId> \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' | jq .
```

### Option B: Trip Circuit Breaker Manually
If you want to place the addon in an open circuit breaker state without changing its stored configuration:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/trip-circuit \
  -H "Content-Type: application/json" \
  -d '{"providerId": "<addonId>", "reason": "EMERGENCY_QUARANTINE"}' | jq .
```

### Option C: Complete Removal & Deletion
Permanently uninstall and delete the addon from storage:
```bash
curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/<addonId> | jq .
```

### Option D: Flush Cache for Quarantined Addon
Ensure no stale responses from this provider remain cached:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/clear-cache \
  -H "Content-Type: application/json" \
  -d '{"namespace": "scrape"}' | jq .
```

---

## 4. Verification & Validation

1. **Verify Addon Is Not in Selection**:
   ```bash
   curl -s http://localhost:7000/v1/providers | jq '.providers[] | select(.id=="<addonId>")'
   # Expected: null or {"enabled": false}
   ```

2. **Verify Stream Scrapes No Longer Query Addon**:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/<addonId> | jq .
   # Expected: 404 Provider disabled or not found
   ```

3. **Verify Overall Catalog Health**:
   ```bash
   curl -s http://localhost:7000/health/status | jq '{status: .status, usableRatio: .details.streamProviders.usableRatio}'
   ```

---

## 5. Post-Incident Review & RCA
- Audit how the rogue addon was imported (e.g. public repository sync vs manual admin import).
- If imported via repository sync, consider blacklisting the manifest URL.
