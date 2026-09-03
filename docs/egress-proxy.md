# Egress proxy guide

`addons-core` makes two kinds of outbound requests: **control-plane** calls
(TMDB, Stremio manifests, debrid APIs) and **data-plane** calls (addon stream
endpoints, proxied media). Data-plane traffic — especially torrent-heavy
addons — often comes from IP ranges that upstream hosts block, which is why a
**residential egress proxy** is optional but common for production.

## Configuration

```sh
# .env (control plane is never proxied)
PROXY_URL=http://user:pass@proxy.example.tld:8080   # alias: SCRAPE_PROXY_URL
SCRAPE_PROXY_MODE=all          # all | allowlist | off  (default: all)
SCRAPE_PROXY_STREAM=true       # route grant upstream fetches through the proxy too
# SCRAPE_PROXY_HOSTS=          # extra host suffixes for 'allowlist' mode
# SCRAPE_PROXY_DIRECT_HOSTS=api.themoviedb.org,api.strem.io   # never proxied
```

- `all` — every data-plane egress goes through the proxy (recommended when
  addon hosts are arbitrary, which they are).
- `allowlist` — only `SCRAPE_PROXY_HOSTS` suffixes are proxied.
- `off` — direct egress (fine for local development; datacenter IPs get
  blocked by many upstreams).

Control-plane hosts (TMDB, Stremio login) are always direct unless listed.

## Cost and privacy considerations

1. **Cost** — residential proxies bill per GB. Stream traffic dominates:
   with `SCRAPE_PROXY_STREAM=true`, every proxied playback byte traverses the
   residential pool. Budget with `EGRESS_PROXY_DAILY_BUDGET_MB` (alert-only)
   and cap streams via `PROXY_MAX_STREAM_BYTES` and
   `MAX_CONCURRENT_STREAMS_*`. The `high-proxy-egress` runbook covers
   response steps when the budget alert fires.
2. **Privacy** — the proxy operator sees destination hosts and traffic
   metadata for everything routed through it. Choose an operator you trust;
   keep control-plane calls (TMDB key, debrid API) direct so credentials do
   not traverse the proxy.
3. **Reliability** — proxy failures surface as scrape failures and circuit
   opens. `GET /debug/traces?hasError=true` and the
   `residential-proxy-failure` runbook (407/502 patterns) are the first stop.

## What does NOT go through the proxy

- Manifest imports and health checks honor the same SSRF policy as everything
  else (`secureFetch`/`urlPolicy`: HTTPS-only in production, private/link-local/metadata
  ranges blocked, per-redirect revalidation) but are governed by
  `IMPORT_*` limits and the manifest pool, not the residential pool.
- Debrid API calls (credential safety) — direct.
- TMDB identity resolution — direct.

## SSRF posture

The proxy is an egress control, not an SSRF boundary: **all** outbound URLs —
proxied or not — pass `validateOutboundUrl` (scheme, host policy, IP
classification, redirect revalidation). See
[docs/runbooks/ssrf-security-incident.md](runbooks/ssrf-security-incident.md)
for the incident flow when denials spike.
