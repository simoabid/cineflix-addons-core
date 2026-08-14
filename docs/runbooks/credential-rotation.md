# Runbook 08: Credential Rotation Procedures

## 1. Overview & Scope
This runbook defines the standard operating procedures (SOP) for rotating credentials in `addons-core`:
1. **Admin Bearer Token** (`ADMIN_TOKEN`)
2. **Master Encryption Key** (`MASTER_KEY`) for sealed addon secrets (AES-256-GCM)
3. **Playback Grant Signing Secret** (`PLAYBACK_GRANT_SECRET`)
4. **Debrid Provider API Keys** (Real-Debrid, AllDebrid, Premiumize)
5. **TMDB API Key** (`TMDB_API_KEY`)

---

## 2. Procedure 1: Rotating Admin Bearer Token

1. **Generate New High-Entropy Token**:
   ```bash
   NEW_ADMIN_TOKEN=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)
   echo "Generated Token: $NEW_ADMIN_TOKEN"
   ```
2. **Update Environment & Restart**:
   ```bash
   export ADMIN_TOKEN="$NEW_ADMIN_TOKEN"
   systemctl restart addons-core
   ```
3. **Verify Auth**:
   ```bash
   curl -s -i -H "Authorization: Bearer $NEW_ADMIN_TOKEN" http://localhost:7000/api/addons | grep "200 OK"
   ```

---

## 3. Procedure 2: Rotating Master Encryption Key (AES-256-GCM)

`addons-core` encrypts sensitive addon configuration secrets and URLs using AES-256-GCM envelope encryption.

### Step 3.1: Generate New 32-Byte Base64 Key
```bash
NEW_MASTER_KEY=$(openssl rand -base64 32)
echo "New Master Key: $NEW_MASTER_KEY"
```

### Step 3.2: Re-encrypt Storage with Re-seal Tooling
1. Export current sanitized/decrypted configuration:
   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/api/addons/export > /tmp/addons-export.json
   ```
2. Update `MASTER_KEY` environment variable:
   ```bash
   export MASTER_KEY="$NEW_MASTER_KEY"
   systemctl restart addons-core
   ```
3. Re-import configuration to re-seal secrets under the new Master Key:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:7000/api/addons/import \
     -H "Content-Type: application/json" \
     -d @/tmp/addons-export.json
   rm /tmp/addons-export.json
   ```

---

## 4. Procedure 3: Rotating Playback Grant Signing Secret

Rotating `PLAYBACK_GRANT_SECRET` invalidates all currently active stream tokens (forcing video players to fetch a fresh stream URL).

```bash
NEW_GRANT_SECRET=$(openssl rand -base64 32)
export PLAYBACK_GRANT_SECRET="$NEW_GRANT_SECRET"
systemctl restart addons-core
```

---

## 5. Procedure 4: Rotating Debrid Provider API Keys

Debrid keys can be rotated live at runtime via the Admin API without restarting the process:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/configure-debrid \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "realdebrid",
    "apiKey": "NEW_DEBRID_API_TOKEN"
  }' | jq .
```

Verify with credential test:
```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:7000/api/addons/admin/actions/test-debrid | jq .
```

---

## 6. Procedure 5: Rotating TMDB API Key

```bash
export TMDB_API_KEY="new_tmdb_api_key"
systemctl restart addons-core
```
```bash
curl -s http://localhost:7000/health/status | jq '.dependencies[] | select(.name=="TMDB")'
```

---

## 7. Verification & Post-Rotation Validation

1. **Verify Health & Dependencies**:
   ```bash
   curl -s http://localhost:7000/health/status | jq '{status: .status, dependencies: .dependencies}'
   ```

2. **Verify Admin Authentication**:
   ```bash
   curl -s -i -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:7000/api/addons | grep "200 OK"
   ```

3. **Verify Scraping & Link Resolution**:
   ```bash
   curl -s http://localhost:7000/v1/movies/550/providers/torrentio | jq .
   ```
