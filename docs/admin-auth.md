# Admin authentication setup

`addons-core` supports several admin auth models. In production, anonymous
administration is impossible — the server refuses to start without a working
auth mode. Roles are ordered `viewer < operator < admin`; only `admin` can
mutate auth, debrid, and quarantine settings.

## Modes (`AUTH_MODE`)

### `static-token` (default in production)

A shared operator token. Send it as `x-admin-token: <token>` or
`Authorization: Bearer <token>` — **never** as a query string (tokens in URLs
leak into logs, referrers, and proxies).

```sh
# generate
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# .env
AUTH_MODE=static-token
ADMIN_TOKEN=<generated>
ADMIN_TOKEN_ROLE=admin   # role granted to this token: viewer|operator|admin
```

The admin UI exchanges the token for an HttpOnly session cookie
(`AUTH_SESSION_SECRET` HMAC; falls back to `ADMIN_TOKEN` when unset) and then
uses CSRF-protected requests. Sessions expire after `AUTH_SESSION_TTL_SEC`
(default 8 h).

### `reverse-proxy`

The edge authenticates users (SSO/OIDC/basic) and forwards identity headers:

```sh
AUTH_MODE=reverse-proxy
AUTH_PROXY_USER_HEADER=x-forwarded-user
AUTH_PROXY_ROLE_HEADER=x-forwarded-role
TRUSTED_PROXY_CIDRS=10.0.0.0/8,127.0.0.1/32   # required in production
```

The server only trusts these headers from `TRUSTED_PROXY_CIDRS`; a missing
allowlist refuses to start in production. Map SSO groups to the
`viewer|operator|admin` roles at the edge.

### `service-jwt`

For machine-to-machine callers (e.g. `cineflix-core` acting as operator):

```sh
AUTH_MODE=service-jwt
SERVICE_JWT_SECRET=<32+ char secret>   # HS256
```

Clients sign short-lived JWTs with an `id` and `role` claim.

### `disabled` — development only

Loopback-only, and only when the host is not exposed; production refuses to
start with it, and non-loopback hosts additionally require
`ALLOW_INSECURE_ADMIN=true` as an explicit acknowledgement (intended for
air-gapped LAN setups, not public exposure).

## Login flow (admin UI / scripts)

```sh
BASE=https://addons.example.tld
# 1. login (sets HttpOnly session cookie, returns CSRF token)
curl -c jar.txt -X POST "$BASE/v1/auth/login" \
     -H 'content-type: application/json' \
     -d '{"token":"'$ADMIN_TOKEN'"}'
# 2. fetch CSRF token for mutations
curl -b jar.txt "$BASE/v1/auth/csrf"
# 3. authenticated call with CSRF header
curl -b jar.txt -H "x-csrf-token: $CSRF" "$BASE/v1/addons"
```

Programmatic callers can skip sessions and use the raw token header directly
on management routes.

## Auditing

All mutations are recorded (`auditMutation`) and queryable via
`GET /v1/audit` (admin). Audit entries carry actor, action, and redacted
targets — never tokens or secret values.

## Rotation

Rotate `ADMIN_TOKEN` by updating the secret and restarting (or use
`reverse-proxy` mode and rotate at the IdP). See
[docs/runbooks/credential-rotation.md](runbooks/credential-rotation.md) for
the zero-downtime procedure.
