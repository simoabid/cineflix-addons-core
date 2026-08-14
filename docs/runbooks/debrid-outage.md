# Runbook 03: Debrid Outage / Key Expiration / Auth Failures

## 1. Metadata
- **Severity**: High
- **Trigger**: Health incident `DEBRID_AUTH_FAILURES`, metric `addons_core_debrid_errors_total{error="AUTH_FAILURE"} > 3`, or debrid resolutions returning `DEBRID_AUTH_FAILURE`.
- **Affected Components**: `DebridService`, `RealDebridResolver`, `AllDebridResolver`, `PremiumizeResolver`, Playback Proxy.
- **Blast Radius**: Torrent streams cannot be resolved or played through web clients.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check Debrid Service Status
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/health/dependencies | jq '.dependencies[] | select(.name=="Debrid")'
```

### Step 2.2: Test Credentials Direct
Trigger an explicit credential check:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/test-debrid | jq .
```
Inspect returned fields:
- `ok`: `false` indicates invalid or expired key.
- `error`: Error message from provider API (e.g. `Bad token`, `Account expired`).
- `premiumDaysRemaining`: 0 indicates expired subscription.

### Step 2.3: Check Debrid Metrics
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/metrics | grep "addons_core_debrid"
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Update Debrid API Key / Credentials
1. Generate a new API token in provider dashboard (Real-Debrid, AllDebrid, or Premiumize).
2. Update config via Admin API (live runtime reload without restart):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/api/addons/admin/actions/configure-debrid \
     -H "Content-Type: application/json" \
     -d '{
       "provider": "realdebrid",
       "apiKey": "NEW_VALID_API_KEY_HERE"
     }' | jq .
   ```
3. Or update environment variables and restart:
   ```bash
   export REALDEBRID_API_KEY="NEW_VALID_API_KEY_HERE"
   systemctl restart addons-core
   ```

### Option B: Failover to Alternative Debrid Provider
If Real-Debrid is experiencing a global outage:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/configure-debrid \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "alldebrid",
    "apiKey": "VALID_ALLDEBRID_API_KEY"
  }' | jq .
```

### Option C: Disable Debrid Temporarily
If no valid debrid key is available, disable debrid so players gracefully fallback to direct HTTP streams:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/configure-debrid \
  -H "Content-Type: application/json" \
  -d '{"provider": "none", "apiKey": ""}' | jq .
```

---

## 4. Verification & Validation

1. **Verify Credential Check**:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/api/addons/admin/actions/test-debrid | jq .
   # Expected: {"ok": true, "user": "...", "premiumDaysRemaining": ...}
   ```

2. **Verify Stream Resolution**:
   Trigger a test stream scrape on a known movie:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/torrentio | jq '.sources[] | select(.type=="stream")'
   ```
   Confirm debrid stream URLs are generated.

---

## 5. Post-Incident Review & RCA
- Audit automated renewal dates on debrid premium accounts.
- Ensure billing notifications alert at least 7 days before subscription expiration.
