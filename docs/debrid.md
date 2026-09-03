# Debrid setup, limitations, and credential rotation

Most Stremio addons return **torrent** streams (`infoHash`). Without debrid,
those cannot be played directly by a browser-based frontend. Debrid providers
resolve cached torrents into direct HTTP links, which `addons-core` then wraps
in short-lived playback grants.

## Setup

Via environment (bootstrap) or the admin API (preferred — stored encrypted):

```sh
# environment bootstrap
DEBRID_PROVIDER=realdebrid     # none | realdebrid | alldebrid | premiumize
DEBRID_API_KEY=your_debrid_api_key
```

```sh
# management API (admin): stored AES-256-GCM-encrypted at rest
curl -X PATCH -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
     -d '{"provider":"realdebrid","apiKey":"..."}' \
     https://addons.example.tld/v1/settings/debrid
# verify credentials
curl -H "x-admin-token: $TOKEN" https://addons.example.tld/v1/settings/debrid/check
```

Responses in the waterfall/sources API distinguish **direct streams** (playable
as-is) from **debrid-resolved streams**; torrent sources without a configured
debrid provider surface a diagnostic instead of a dead link.

## Limitations

- **Cache-dependence** — providers only resolve torrents cached by *any*
  user of the service; rare torrents may be uncached. The
  `debrid.uncachedJob` background flow can transfer uncached items (provider
  permitting, at your cost).
- **Account limits** — providers cap concurrent downloads/fair use; per-day
  call budgets (`PROVIDER_DAILY_CALL_BUDGET`, budget overrides) and the debrid
  concurrency pool (`CONCURRENCY_DEBRID`) keep usage inside them.
- **Credential sensitivity** — a debrid key is a paid account credential. It
  is stored AES-256-GCM-encrypted with `SECRETS_MASTER_KEY`, redacted in all
  logs/audits/responses, and never included in exports.
- **Geography** — cached-torrent availability and link TTLs vary by provider
  region.

## Troubleshooting

- Auth failures (`AUTH_FAILURE` classification, rising
  `addons_core_debrid_errors_total`): the [debrid outage
  runbook](runbooks/debrid-outage.md) — verify key, check plan status, rotate.
- Slow/no results for torrents that used to resolve: provider cache miss or
  account limit; check `GET /v1/debrid/transfers` for stuck jobs.
- Link expiry: resolved links are short-lived by provider design; grants
  enforce their own TTL on top (`PLAYBACK_GRANT_TTL_SEC`).

## Credential rotation

Rotate on schedule (quarterly recommended) and immediately on suspicion of
leak:

1. Generate a new API key in the provider dashboard.
2. `PATCH /v1/settings/debrid` with the new key (zero downtime — the next
   resolution uses it).
3. Run `GET /v1/settings/debrid/check` → success.
4. Revoke the old key in the provider dashboard.
5. Verify no old-key failures in `GET /v1/audit` / `/debug/traces`.

Full procedure with dual-key notes:
[docs/runbooks/credential-rotation.md](runbooks/credential-rotation.md).
