# Runbook 12: Zero-Downtime Rollback & Database Migration Rollback

## 1. Metadata
- **Severity**: Critical
- **Trigger**: Post-deployment error spike, crash loops, failed storage schema migrations, or unexpected API regressions.
- **Affected Components**: Node.js Service Process, Docker Container, Migration Runner, Storage Backend.
- **Blast Radius**: Entire `addons-core` service.

---

## 2. Fast Rollback Decision Matrix

| Condition | Action |
|---|---|
| Process crashing on boot / OOM / syntax errors | **Container / Image Rollback** |
| Schema migration corrupted addon records | **Storage Backup Restore + Image Rollback** |
| Config env error (e.g. invalid `REDIS_URL`) | **Config Reversion & Service Restart** |
| Upstream dependency regression | **Circuit Breaker / Degraded Mode Fallback** |

---

## 3. Step-by-Step Rollback Procedures

### Procedure 1: Docker / Container Image Rollback
1. **Identify Previous Working Image Tag**:
   ```bash
   docker images | grep addons-core
   # Example: cineflix/addons-core:v1.0.4 (stable) vs v1.0.5 (broken)
   ```
2. **Deploy Previous Image**:
   ```bash
   docker stop addons-core
   docker rm addons-core
   docker run -d --name addons-core \
     --restart unless-stopped \
     --env-file /etc/addons-core/.env \
     -v /var/lib/addons-core/data:/app/data \
     -p 7000:7000 \
     cineflix/addons-core:v1.0.4
   ```

### Procedure 2: Git / Systemd Service Rollback
1. **Checkout Previous Stable Release Tag**:
   ```bash
   cd /opt/cineflix/addons-core
   git log --oneline -n 5
   git checkout tags/v1.0.4 -b rollback-v1.0.4
   ```
2. **Rebuild & Restart**:
   ```bash
   npm ci --production
   npm run build
   systemctl restart addons-core
   ```

### Procedure 3: Schema Migration & Data State Rollback
If a schema migration failed mid-way or produced invalid JSON:
1. Stop the service:
   ```bash
   systemctl stop addons-core
   ```
2. Restore the pre-migration automatic backup:
   ```bash
   # Migration runner generates backups named data/addons.json.bak.<timestamp>
   LATEST_PRE_MIGRATION_BAK=$(ls -t data/addons.json.bak.* | head -n 1)
   echo "Restoring from: $LATEST_PRE_MIGRATION_BAK"
   cp "$LATEST_PRE_MIGRATION_BAK" data/addons.json
   ```
3. Start the previous stable version of `addons-core`:
   ```bash
   systemctl start addons-core
   ```

---

## 4. Verification & Validation

1. **Verify Liveness and Process Stability**:
   ```bash
   curl -s -i http://localhost:7000/health/live | grep "200 OK"
   ```

2. **Verify Readiness and Storage State**:
   ```bash
   curl -s -i http://localhost:7000/health/ready | grep "200 OK"
   ```

3. **Verify Version String**:
   ```bash
   curl -s http://localhost:7000/health/status | jq '{version: .version, status: .status}'
   ```

4. **Verify Core Routes**:
   ```bash
   curl -s http://localhost:7000/v1/providers | jq '{count: (.providers | length)}'
   curl -s http://localhost:7000/v1/movies/550/providers/torrentio | jq '{status: "ok"}'
   ```

---

## 5. Post-Incident Review & RCA
- Analyze the failure in staging before attempting another release.
- Ensure automated canary validation is run against the staging environment.
