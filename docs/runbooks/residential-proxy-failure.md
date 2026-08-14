# Runbook 02: Residential Proxy Failure / Egress Blocked

## 1. Metadata
- **Severity**: High
- **Trigger**: Upstream scrapers return `407 Proxy Authentication Required`, `502 Bad Gateway`, or Cloudflare 403 / IP Challenge blocks.
- **Affected Components**: `scrapeFetch`, `ProxyAgent`, Egress Outbound Network.
- **Blast Radius**: Scraping from Cloudflare-protected providers (e.g. Torrentio, MediaFusion) fails across all media.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check Egress Proxy Configuration
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/health/dependencies | jq '.dependencies[] | select(.name=="EgressProxy")'
```

### Step 2.2: Test Direct vs Proxied Connectivity
Test whether the failure is proxy-specific:
```bash
# Test through addons-core egress helper
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/debug/traces?hasError=true | jq '.spans[] | select(.attributes["http.status_code"]==407 or .attributes["http.status_code"]==502)'
```

### Step 2.3: Check Provider Error Classification in Metrics
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/metrics | grep -E 'addons_core_provider_failures_total.*(blocked|network_error|http_5xx)'
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Rotate Residential Proxy Credentials or Endpoint
If proxy bandwidth is exhausted or the proxy IP pool is banned:
1. Update environment variables in container / systemd:
   ```bash
   export SCRAPE_PROXY_URL="http://new_user:new_pass@residential.proxyprovider.com:8000"
   export SCRAPE_PROXY_MODE="allowlist"
   ```
2. Restart service or reload config:
   ```bash
   systemctl restart addons-core
   # OR for docker:
   docker restart addons-core
   ```

### Option B: Fallback to Direct Egress (Temporary Bypass)
If the proxy provider is down and datacenter IPs are not blocked for secondary providers:
1. Set `SCRAPE_PROXY_MODE="off"`:
   ```bash
   export SCRAPE_PROXY_MODE="off"
   systemctl restart addons-core
   ```
2. Monitor provider success rate under direct egress.

### Option C: Adjust Proxy Allowlist Hosts
If only specific domains should use the proxy (saving residential bandwidth):
```bash
export SCRAPE_PROXY_ALLOWLIST="torrentio.strem.fun,mediafusion.elfhosted.com"
systemctl restart addons-core
```

---

## 4. Verification & Validation

1. **Verify Proxy Logs on Boot**:
   ```bash
   journalctl -u addons-core -n 50 | grep "egress proxy"
   # Expected: Scrape egress proxy ON mode=allowlist ...
   ```

2. **Trigger Test Scrape on Protected Provider**:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/torrentio | jq .
   ```
   Confirm sources are returned and `diagnostics` has no `PROVIDER_ERROR`.

---

## 5. Post-Incident Review & RCA
- Review residential proxy provider SLA and monthly bandwidth quota.
- Set up bandwidth alerts in proxy provider dashboard before pool exhaustion.
