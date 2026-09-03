# Documentation index

| Document | Contents |
|---|---|
| [Architecture](architecture.md) | System diagram, module map, ADR index |
| [Concepts](concepts.md) | Bulk vs waterfall vs subtitles vs health vs readiness; direct vs debrid streams; revisions |
| [Installation](installation.md) | Local, Docker, production setup |
| [Configuration reference](configuration.md) | Config tiers, required values, unsafe combinations |
| [Security checklist](security-checklist.md) | Production go-live gate |
| [Admin auth](admin-auth.md) | Auth modes, sessions, CSRF, roles, rotation |
| [Reverse proxy / TLS](reverse-proxy.md) | Edge requirements, Caddy/nginx examples |
| [Egress proxy](egress-proxy.md) | Residential proxy config, cost & privacy |
| [Debrid](debrid.md) | Setup, limitations, credential rotation |
| [Addon admission](addon-admission.md) | Import paths, capabilities, troubleshooting |
| [API reference](api-reference.md) | Route families, conventions, generated OpenAPI |
| [CINEFLIX integration](integration-cineflix.md) | Waterfall contract for the frontend |
| [Stremio integration](integration-stremio.md) | Native re-exposure as a Stremio addon |
| [Observability](observability.md) | Health semantics, metrics, traces, alerts, dashboards |
| [Backup / DR](backup-restore.md) | RPO/RTO, procedures, quarterly drills |
| [Supply chain](supply-chain.md) | Base images, SBOM, scanning, framework review |
| [Support policy](support-policy.md) | Compatibility guarantees, deprecations |
| [Runbooks](runbooks/) | Incident response (13 runbooks + index) |
| [ADRs](adr/) | Architecture decision records |

Operational quick links: [runbook index](runbooks/INDEX.md) ·
[OpenAPI spec](openapi.yaml) · [contributing](../CONTRIBUTING.md)
