# Reverse proxy / TLS deployment guide

Phase 10 §13.3 — `addons-core` must run behind a TLS-terminating edge in
production. The edge owns certificates, HTTP/2, request size limits, rate
limiting, admin IP allowlisting, forwarded headers, and redacted access logs.

## Requirements on the edge

1. **TLS** with automated certificate management (ACME) — `PUBLIC_URL` must
   match the externally reachable `https://` origin (no trailing slash); the
   server fails to start otherwise, and the startup grant-origin assertion
   verifies generated playback URLs use that origin.
2. **Forwarded headers** — set `X-Forwarded-Proto: https`, `X-Forwarded-Host`,
   and `X-Forwarded-For` from the real client. When `AUTH_MODE=reverse-proxy`,
   the edge authenticates and sets `X-Forwarded-User` / `X-Forwarded-Role`;
   `TRUSTED_PROXY_CIDRS` must list the edge so the server only trusts those
   headers from it.
3. **Request limits** — body size ≤ 1 MiB (management API bodies are small),
   header size limits, and idle/request timeouts below your proxy budget.
4. **Rate limiting / WAF** — the server rate-limits per-IP internally; the
   edge should add coarse protection (e.g. 100 req/s per IP) and WAF rules for
   the admin area.
5. **Admin allowlisting** — restrict `/admin`, `/v1/auth`, and management
   routes to operator IPs/VPN where possible.
6. **Access logs with redaction** — never log query strings on proxy routes;
   playback grants appear only as path segments.

## Streaming caveats

- Source playback goes through `/v1/proxy/grant/:id` — a streaming path with
  `Range` support. Do **not** buffer these responses at the edge; forward
  `Range` and pass through `206`/`416` semantics.
- Set generous-but-bounded read timeouts for `/v1/proxy/*` (the server caps
  streams at `PROXY_MAX_STREAM_BYTES`, default 512 MiB).
- Do not cache `/v1/proxy/*` or `/v1/movies/*` at the edge; responses are
  grant-scoped and revision-aware.

## Caddy example

```caddy
addons.example.tld {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3006 {
        header_up X-Forwarded-Proto {scheme}
        # Admin + management paths only from operator ranges:
        @admin path /admin* /v1/auth* /v1/addons* /v1/settings* /v1/jobs*
        handle @admin {
            # e.g. remote_ip 203.0.113.0/24  (or forward_auth to SSO)
            reverse_proxy 127.0.0.1:3006
        }
    }
    request_body {
        max_size 1MB
    }
}
```

## nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name addons.example.tld;
    ssl_certificate     /etc/letsencrypt/live/addons/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/addons/privkey.pem;

    client_max_body_size 1m;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;              # required for /v1/proxy streaming

    location /v1/proxy/ {
        proxy_read_timeout 300s;
        proxy_pass http://127.0.0.1:3006;
    }

    location / {
        proxy_pass http://127.0.0.1:3006;
    }
}
```

## Verification

After wiring the edge:

1. `curl -sS https://addons.example.tld/health/live` → `200`.
2. `curl -sS https://addons.example.tld/v1/providers` → providers with
   `x-provider-revision`.
3. Query a source and confirm its URL starts with `https://addons.example.tld/v1/proxy/grant/`
   (the startup assertion enforces origin match; this confirms the edge path).
4. Confirm `X-RateLimit-*` headers appear and that anonymous management
   requests are denied (401).
