# Backup and disaster recovery guide

Phase 10 §13.4 — procedures, targets, and drill schedule for recovering
`addons-core` state. Operational incident steps live in
[docs/runbooks/data-restore.md](runbooks/data-restore.md).

## What state exists

| State | Location | Secret-bearing | Recoverable from |
|---|---|---|---|
| Installed addons, ordering, timeouts | `data/addons.json` (file store) / `addons` table (postgres) | Yes — addon transport URLs can embed tokens | Backup + (optionally) re-import |
| Debrid configuration | `data/` (file store) / debrid tables | Yes — API keys (AES-256-GCM envelope-encrypted at rest) | Backup **or** re-enter credentials (rotation runbook) |
| Audit log | `data/audit.jsonl` / audit table | Metadata only | Backup (retention policy applies) |
| Background jobs | jobs tables / file store | No | Re-created on boot; unfinished jobs re-run |
| Cache (memory/redis) | volatile / redis | No | Not backed up — repopulates |

The secrets master key (`SECRETS_MASTER_KEY`) is **not** stored with the
backups — without it, encrypted debrid keys in a restored snapshot cannot be
decrypted. Keep a key-backup strategy appropriate to your secrets manager
(e.g. sealed offline copy or HSM-backed escrow), documented in
[docs/runbooks/credential-rotation.md](runbooks/credential-rotation.md).

## Targets

| Metric | Target | Notes |
|---|---|---|
| RPO (max data loss) | 24 h (file store) / 15 min (postgres + WAL) | Daily snapshot cadence; postgres deployments should enable continuous archiving |
| RTO (max restore time) | 1 h | Restore + verify + redeploy behind the edge |
| Restore drill | Quarterly (staging) | `docs/runbooks/data-restore.md` §drill |

## Procedures

### Backup (production)

```sh
# Encrypted with age (preferred):
scripts/backup.sh --out /var/backups/addons-core \
    --age-recipient age1...operator

# Or with gpg:
scripts/backup.sh --out /var/backups/addons-core --gpg-key ops@example.tld
```

Schedule daily via cron/systemd-timer. Backups are secret-bearing (addon
transport URLs, encrypted debrid keys) — always encrypt at rest, restrict
read access, and apply the deletion policy below.

### Restore

1. Stop the service (or deploy the replacement instance with the data volume
   empty).
2. Decrypt and unpack the chosen snapshot into `data/` (file store) or restore
   the postgres dump (postgres backend).
3. Restore `SECRETS_MASTER_KEY` for the environment (must match the one that
   encrypted the snapshot's debrid keys).
4. Start the service; verify `GET /health/ready` → 200 and
   `GET /v1/providers` lists the expected addons with a fresh revision.
5. Exercise one playback grant through the proxy before re-admitting traffic.

### Configuration export/import with redaction

For moving addon sets *between environments* (never a production→shared-dev
copy), use the management API export, which redacts secrets:

```sh
curl -H "x-admin-token: $TOKEN" https://addons.example.tld/v1/settings/export \
    > staging-fixture.json
```

### Deletion / retention policy

- Keep 14 daily + 4 weekly + 6 monthly snapshots; prune older ones.
- Encrypted backups whose master key has been rotated out are destroyed at the
  next retention prune.
- Operator-initiated deletions (addon removal) propagate to the next snapshot;
  snapshots themselves are immutable.

## Quarterly restore drill (staging)

1. Restore the latest production backup into the staging environment with the
   *staging* `SECRETS_MASTER_KEY` — this must FAIL for debrid keys (proves the
   key separation) and succeed for addon structure.
2. Restore into a scratch instance with the production master key held
   offline: verify provider list, ordering, one playback grant, debrid config
   present.
3. Record the drill (date, snapshot age, elapsed time, issues) in the
   operations log; RTO target 1 h.
