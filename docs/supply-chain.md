# Supply-chain governance

Phase 10 §13.5 — how dependency, base-image, and upstream-framework changes
are reviewed, pinned, scanned, and released.

## Lockfile and dependency updates

- `package-lock.json` is committed; installs use `npm ci` everywhere (local
  script via `prepare`, Dockerfile, CI).
- Renovate (`.github`-recognized `renovate.json`) opens weekly update PRs:
  - **Runtime `dependencies`**: never automerge — human review required.
  - **`@omss/framework`**: never automerge and always human-reviewed. It
    controls routing, proxy behavior, source aggregation, and health
    semantics; a framework change is effectively a behavioral release.
    Review checklist: route surface diffs, proxy/grant semantics, health
    status semantics, cache key changes. Run `npm run perf` and the full
    gates before merging.
  - **devDependencies** (minor/patch): grouped PR, automerged only after the
    full CI gate passes.
- Vulnerability alerts are enabled with the `security` label; security patches
  bypass the weekly schedule.

## Base images

- The Dockerfile pins `node:22-alpine` by **digest** (amd64 manifest).
  Bumping the digest is a deliberate supply-chain change: check the Node
  release notes, run the full gates, and run one staging deploy before
  tagging a release. (Multi-arch builds, if introduced, should re-pin per
  architecture.)
- The production image contains runtime dependencies only
  (`npm ci --omit=dev`), runs as a non-root user, drops capabilities, mounts a
  read-only root filesystem, and exposes a liveness HEALTHCHECK (see
  `Dockerfile` / `compose.yml`).

## SBOM

- `npm run sbom` generates a CycloneDX 1.5 SBOM from the committed lockfile
  (`scripts/sbom.js`, dependency-free) → `sbom/addons-core.cdx.json`.
- CI generates an SBOM per container build and uploads it as a workflow
  artifact; keep one SBOM per release tag alongside the image digest.
- Registry admission (when a registry is used): verify the image digest and
  attach/verify the SBOM and signature (cosign) before rollout.

## Image scanning

- CI scans the built image with Trivy (`aquasecurity/trivy-action`), with
  `--ignore-unfixed` so unfixed base-image CVEs do not block; fixed CRITICAL
  findings fail the build. Add waives to `.trivyignore` with a comment and an
  expiry date — never silent ignores.
- Scan results are also reviewed monthly against the base-image digest bump
  cadence.

## Secrets and supply-chain hygiene

- No tokens in query strings, logs, audits, or responses (`redactString` /
  `redactUrl`); pre-commit + CI secret scans block credential commits.
- Debrid keys at rest are AES-256-GCM envelope-encrypted (`SecretBox`) with
  `SECRETS_MASTER_KEY`; rotation is dual-key and phased
  (docs/runbooks/credential-rotation.md).
- Git history must stay free of secrets: if a leak occurs, rotate first, then
  rewrite history (docs/runbooks/ssrf-security-incident.md has the incident
  flow).

## Release mapping

A release maps to: a git tag (conventional commits) → the exact commit →
`package-lock.json` digest → container image digest → SBOM artifact. CI
publishes the image digest and SBOM as artifacts on every build so a running
deployment can always be traced back to source.
