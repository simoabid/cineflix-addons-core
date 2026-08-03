# ADR 0002 — Phase 0 quality gates

Status: Accepted

## Context

Before Phase 0 the project had `build` and `test` scripts but no reproducible
formatting check, no lint gate, and no CI. The delivery plan (Phase 0, section
3.3) asked for delivery gates before further feature work.

## Decision

Establish the following minimum reproducible gates, run in this order from a
clean checkout of this repository:

1. `npm ci` — install exactly the committed dependency versions.
2. `npm run build` — TypeScript compile via `tsc`.
3. `npm test` — build, then run the `node --test` suite in `test/`.
4. `npm run format:check` — Prettier check over `src/`.
5. `npm run lint` — ESLint over `src/` using the flat `eslint.config.js`.

The package scripts and `eslint.config.js` that make these gates runnable were
added in Phase 0. The existing source files were normalized to the committed
Prettier configuration so `format:check` can pass; this normalization does not
change behavior (verified by diffing against Prettier-formatted HEAD sources).

## Consequences

- Every Phase 0 change is reproducible and testable from a clean checkout.
- Formatting and lint are enforced without editing the working tree.
- These gates are minimums, not a full release process.

## Limitations

The following gates are intentionally out of scope for Phase 0 and are not yet
available:

- No production deployment pipeline.
- No API contract tests.
- No integration tests against live or containerized dependencies.
- No automated secret scan or dependency/container vulnerability scan in CI.
- No effective `CODEOWNERS` (real maintainer handles must be supplied before
  enabling it; see `.github/CODEOWNERS.example`).
