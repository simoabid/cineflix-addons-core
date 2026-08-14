# Runbook 07: High Proxy Egress / Bandwidth Spikes / Abuse

## 1. Metadata
- **Severity**: Medium (Cost & Bandwidth capacity risk)
- **Trigger**: Sudden spike in `addons_core_proxy_egress_bytes_total`, active proxy streams `addons_core_proxy_active_streams > 100`, or bandwidth exceeding hosting budget.
- **Affected Components**: `proxyRoute`, `PlaybackGrantStore`, Fastify Stream Dispatcher.
- **Blast Radius**: Increased cloud bandwidth costs, proxy saturation, possible CDN or server egress rate limits.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check Active Proxy Streams and Bandwidth Rate
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/metrics | grep "addons_core_proxy"
```
Key metrics:
- `addons_core_proxy_active_streams`: Current number of open video stream connections.
- `addons_core_proxy_egress_bytes_total`: Total egress bytes transferred.
- `addons_core_proxy_range_requests_total`: High range requests indicate video seeking / scraping bots.

### Step 2.2: Identify Top Requesting IPs from Logs
```bash
journalctl -u addons-core -n 200 | grep "/v1/proxy/" | awk '{print $1, $7}' | sort | uniq -c | sort -nr | head -n 10
```

### Step 2.3: Check URL Policy and Grant TTL
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/health/dependencies | jq '.dependencies[] | select(.name=="PlaybackGrants")'
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Revoke Abusive Grants or Mass-Revoke Active Grants
If specific grants are being shared publicly:
```bash
# Revoke single grant:
curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/v1/proxy/grant/<grantId>
```
To instantly invalidate all active playback grants and force re-generation:
1. Update `PLAYBACK_GRANT_SECRET` in environment:
   ```bash
   export PLAYBACK_GRANT_SECRET="NEW_32_CHAR_LONG_RANDOM_SECRET_KEY_HERE"
   systemctl restart addons-core
   ```

### Option B: Shorten Playback Grant TTL
Reduce the window during which stream URLs remain valid:
```bash
export PLAYBACK_GRANT_TTL_SEC="600" # 10 minutes instead of 1 hour
systemctl restart addons-core
```

### Option C: Restrict Max Stream Bytes and Concurrency
Cap stream size to prevent runaway downloads:
```bash
export PROXY_MAX_STREAM_BYTES="2147483648" # 2 GB limit per single stream
systemctl restart addons-core
```

### Option D: Block / Rate Limit Abusive Client IPs
Add abusive IPs to firewall / reverse proxy:
```bash
# Example UFW or iptables rule:
ufw insert 1 deny from 203.0.113.45 to any port 7000
```

---

## 4. Verification & Validation

1. **Verify Active Stream Decrement**:
   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/metrics | grep "addons_core_proxy_active_streams"
   ```

2. **Verify Stream Limit Enforcement**:
   Attempt to stream a file larger than `PROXY_MAX_STREAM_BYTES` and verify it aborts with 502 `BODY_TOO_LARGE`.

---

## 5. Post-Incident Review & RCA
- Evaluate implementing per-user concurrency limits on proxy streams.
- Consider offloading large video file streaming to client-side direct debrid links where CORS is supported.
