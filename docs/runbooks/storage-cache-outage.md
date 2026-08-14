# Runbook 05: Storage & Cache Backend Outage (Redis/File)

## 1. Metadata
- **Severity**: Critical
- **Trigger**: Readiness probe failing with 503 (`/health/ready`), health incident `STORAGE_DEGRADED` or `CACHE_DEGRADED`, or Redis connection timeouts.
- **Affected Components**: `FileStorageBackend`, `RedisStorageBackend`, `CacheManager`, `JobEngine`.
- **Blast Radius**: Addon mutations fail, distributed locks fail, cached responses bypass to upstreams.

---

## 2. Initial Triage & Fast Diagnosis

### Step 2.1: Check Readiness Probe
```bash
curl -s -i http://localhost:7000/health/ready
```
Inspect returned JSON `checks`:
- `storage.ok`: `false` indicates storage layer failure.
- `cache.ok`: `false` indicates cache layer failure.
- `jobEngine.ok`: `false` indicates job engine cannot poll storage.

### Step 2.2: Check Redis Connectivity (If using Redis)
```bash
redis-cli -u "$REDIS_URL" PING
# Expected: PONG
```
Check Redis latency and memory:
```bash
redis-cli -u "$REDIS_URL" INFO memory
redis-cli -u "$REDIS_URL" INFO stats
```

### Step 2.3: Check File Storage Directory & Permissions (If using File store)
```bash
ls -la data/
df -h data/
touch data/.write_test && rm data/.write_test
```

---

## 3. Mitigation & Step-by-Step Recovery

### Option A: Redis Outage / Restart / Failover
If Redis is down or unreachable:
1. **Restart Redis service**:
   ```bash
   systemctl restart redis-server
   ```
2. **Failover to Replica / Standby Cluster**:
   Update `REDIS_URL` in environment:
   ```bash
   export REDIS_URL="redis://standby-redis.internal:6379"
   systemctl restart addons-core
   ```
3. **Emergency In-Memory / File Fallback** (Temporary Degradation):
   If Redis cannot be recovered, fallback to local storage & in-memory cache:
   ```bash
   export CACHE_TYPE="memory"
   export ADDONS_STORE="file"
   systemctl restart addons-core
   ```

### Option B: File Storage Disk Full or Read-Only Error
1. Check disk space: `df -h /var/lib/addons-core`
2. Clear temporary or old backup files in `data/`:
   ```bash
   find data/ -name "*.bak.*" -mtime +7 -delete
   ```
3. Fix ownership and permissions:
   ```bash
   chown -R cineflix:cineflix data/
   chmod 755 data/
   chmod 644 data/*.json
   ```

### Option C: Resolve Optimistic Lock Contention
If logs report repeated `OptimisticLockError`:
1. Check if multiple instances are mutating storage concurrently without Redis locks.
2. Ensure `CACHE_TYPE=redis` and `ADDONS_STORE=redis` in multi-instance setups.

---

## 4. Verification & Validation

1. **Verify Readiness Probe (Must be 200 OK)**:
   ```bash
   curl -s -i http://localhost:7000/health/ready | grep "HTTP/1.1 200"
   ```

2. **Verify Storage Write & Read**:
   ```bash
   export ADMIN_TOKEN="your_admin_token"
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:7000/api/addons | jq '.revision'
   ```

---

## 5. Post-Incident Review & RCA
- Configure Redis maxmemory eviction policies (`volatile-lru` or `allkeys-lru`).
- Set up disk space threshold alerts at 80% usage.
