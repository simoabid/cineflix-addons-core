# Runbook 09: Disaster Recovery & Data Restore from Backups

## 1. Overview & Recovery Objectives
- **RPO (Recovery Point Objective)**: < 1 hour (via automated backups / transaction log snapshots).
- **RTO (Recovery Time Objective)**: < 5 minutes.
- **Triggers**: Storage file corruption, accidental addon deletion, failed manual DB edits, or hard drive loss.

---

## 2. Backup File Locations & Naming Conventions

`addons-core` automatically creates timestamped backups during data migrations and imports:
- **Default Storage Path**: `data/addons.json`
- **Automatic Migration Backups**: `data/addons.json.bak.YYYY-MM-DDTHH-mm-ss-msZ`
- **Manual Snapshots**: `data/backups/addons-snapshot-*.json`

---

## 3. Step-by-Step Restoration Procedure

### Step 3.1: Stop addons-core Service
Prevent concurrent writes during restoration:
```bash
systemctl stop addons-core
# OR
docker stop addons-core
```

### Step 3.2: Identify Most Recent Clean Backup
List all available backups in order of modification time:
```bash
ls -lht data/*.bak.* data/backups/
```
Select the latest known good backup (e.g. `data/addons.json.bak.2026-08-14T20-00-00-000Z`).

### Step 3.3: Validate Backup JSON Integrity
```bash
python3 -m json.tool data/addons.json.bak.2026-08-14T20-00-00-000Z > /dev/null
# Check exit code:
echo $? # Must be 0
```

### Step 3.4: Restore File Storage
```bash
# Preserve corrupted file for forensics:
cp data/addons.json data/addons.json.corrupted.$(date +%s)

# Overwrite active storage file:
cp data/addons.json.bak.2026-08-14T20-00-00-000Z data/addons.json

# Fix permissions:
chown cineflix:cineflix data/addons.json
chmod 644 data/addons.json
```

### Step 3.5: Restore Redis Storage (If Using Redis Store)
If using Redis backend (`ADDONS_STORE=redis`):
1. Flush corrupted keys or restore from RDB snapshot:
   ```bash
   redis-cli -u "$REDIS_URL" --rdb /var/backups/redis/dump.rdb
   ```
2. Or use the import API once the service starts.

### Step 3.6: Start addons-core and Verify
```bash
systemctl start addons-core
```

---

## 4. Verification & Post-Restoration Checks

1. **Verify Liveness and Readiness**:
   ```bash
   curl -s http://localhost:7000/health/ready | jq .
   # Expected: {"status": "ok", "ready": true, ...}
   ```

2. **Verify Addon Count and Catalog**:
   ```bash
   export ADMIN_TOKEN="your_admin_token"
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:7000/api/addons | jq '{count: (.addons | length), revision: .revision}'
   ```

3. **Verify Playback & Scraping**:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/torrentio | jq .
   ```

---

## 5. Post-Incident Review & RCA
- Investigate what caused the data corruption (e.g. ungraceful power loss, bad migration script, disk I/O error).
- Ensure daily offsite snapshot backups are configured via cron or cloud storage.
