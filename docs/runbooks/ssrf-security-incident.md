# Runbook 10: SSRF & Security Incident Response

## 1. Metadata
- **Severity**: Critical / High
- **Trigger**: Metric `addons_core_proxy_denied_ssrf_total` increasing rapidly, audit log emitting `SSRF_ATTEMPT_BLOCKED`, or suspicious private IP/metadata requests.
- **Affected Components**: `urlPolicy`, `proxyRoute`, `PlaybackGrantStore`, `AuditLogger`.
- **Blast Radius**: Potential unauthorized intranet probing, cloud metadata theft (`169.254.169.254`), or credential exfiltration attempts.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check SSRF Rejection Metrics
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/metrics | grep "addons_core_proxy_denied_ssrf_total"
```

### Step 2.2: Inspect Audit Logs for Blocked Targets
```bash
journalctl -u addons-core -n 200 | grep -E "(URL_POLICY_VIOLATION|SSRF_ATTEMPT|BLOCKED_IP)"
```
Identify:
- Targeted internal IP addresses (e.g. `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, `[::1]`).
- The requesting client IP or actor ID.
- The addon manifest or stream URL that supplied the malicious upstream target.

### Step 2.3: Verify Outbound URL Policy Settings
Ensure policy enforces strict IPv4/IPv6 private IP rejection, metadata blocklists, and DNS pin rebinding defense.

---

## 3. Mitigation & Containment Steps

### Step 3.1: Identify and Quarantine Malicious Addon
If a rogue Stremio addon is returning internal IP streams:
```bash
# Disable addon immediately:
curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/<maliciousAddonId> \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' | jq .
```
Or delete it entirely:
```bash
curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/<maliciousAddonId>
```

### Step 3.2: Mass Invalidate All Active Playback Grants
Prevent any pending malicious grants from being redeemed:
```bash
# Rotate PLAYBACK_GRANT_SECRET to instantly invalidate all tokens:
export PLAYBACK_GRANT_SECRET="$(openssl rand -base64 32)"
systemctl restart addons-core
```

### Step 3.3: Tighten Host Allowlist (Strict Mode)
If under active targeted attack, enforce an explicit outbound domain allowlist:
```bash
export OUTBOUND_HOST_ALLOWLIST="real-debrid.com,alldebrid.com,premiumize.me,api.themoviedb.org"
systemctl restart addons-core
```

---

## 4. Verification & Validation

1. **Verify SSRF Blocking via Probe**:
   Attempt to issue a grant for a loopback URL (must fail with 400/403):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/api/addons/admin/actions/test-url-policy \
     -H "Content-Type: application/json" \
     -d '{"url": "http://169.254.169.254/latest/meta-data/"}' | jq .
   # Expected: {"allowed": false, "reason": "CLOUD_METADATA_PROHIBITED"}
   ```

2. **Verify DNS Rebinding Protection**:
   `validateOutboundUrl` pins DNS and rejects mixed public/private resolutions.

---

## 5. Post-Incident Review & RCA
- File security incident report with logged IPs and attack payloads.
- Check cloud provider metadata service access controls (e.g. enforce IMDSv2 on AWS).
- Audit all installed community addons.
