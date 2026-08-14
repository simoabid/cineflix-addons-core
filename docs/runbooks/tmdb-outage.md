# Runbook 04: TMDB API Outage / Rate Limit

## 1. Metadata
- **Severity**: Critical (if TMDB is completely unreachable and cache is cold) / High (rate limits)
- **Trigger**: Health incident `TMDB_OUTAGE`, TMDB returning 429 / 500, or media resolution errors `TMDB_FETCH_FAILED`.
- **Affected Components**: `MediaIdentityService`, TMDB Metadata Client, Subtitle & Scrape Handlers.
- **Blast Radius**: Scraping movies and series fails when TMDB metadata cannot be resolved.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check TMDB Dependency Status
```bash
export ADMIN_TOKEN="your_admin_token"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/health/dependencies | jq '.dependencies[] | select(.name=="TMDB")'
```

### Step 2.2: Test TMDB API Direct Connectivity
```bash
curl -s -w "\nHTTP Status: %{http_code}\n" \
  "https://api.themoviedb.org/3/movie/550?api_key=$TMDB_API_KEY"
```

### Step 2.3: Check Media Identity Cache Hit/Miss Metrics
```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/metrics | grep "addons_core_cache"
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Rotate / Replace TMDB API Key
If the TMDB API key has hit quota or was revoked:
1. Generate or retrieve an alternative TMDB v3 API Key or Read Access Token (v4).
2. Update environment variable:
   ```bash
   export TMDB_API_KEY="new_tmdb_api_key"
   systemctl restart addons-core
   ```

### Option B: Leverage Long-Lived Media Cache & Negative Cache
If TMDB is experiencing a brief global outage:
1. Verify `MediaIdentityService` is utilizing in-memory and Redis caches.
2. If callers provide `imdbId` (e.g. `tt0137523`), `MediaIdentityService` can resolve cached mappings without querying TMDB repeatedly.

### Option C: Configure TMDB Proxy / Mirror
If TMDB is IP-blocking the server datacenter:
1. Route TMDB requests through an outbound proxy:
   ```bash
   export TMDB_BASE_URL="https://tmdb-proxy.internal.cineflix.app/3"
   systemctl restart addons-core
   ```

---

## 4. Verification & Validation

1. **Verify Health Endpoint**:
   ```bash
   curl -s http://localhost:7000/health/status | jq '.dependencies[] | select(.name=="TMDB")'
   # Expected: {"name": "TMDB", "status": "ok", "latencyMs": ...}
   ```

2. **Verify Media Identity Resolution**:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/torrentio | jq '{providerId: .providerId, sourcesCount: (.sources | length)}'
   ```

---

## 5. Post-Incident Review & RCA
- Maintain at least 2 fallback TMDB API keys in secrets manager.
- Ensure TTL for positive media metadata cache is configured to at least 24 hours.
