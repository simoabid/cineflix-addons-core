# ADR 0005 — Phase 9 test strategy and quality tooling

Status: Accepted

## Context

The delivery plan (Phase 9, section 12) requires an explicit test strategy
(unit / integration / contract / e2e / security / performance layers), code
quality tooling beyond the Phase 0 gates, and a codified decision about how
tests run relative to the build.

## Decision

### Tests run from the compiled artifact, from a clean output

Tests import `../dist/...` (Node's test runner against compiled JS). This is
kept intentionally: the tested artifact is the same one the container runs.
The choice is codified as `npm run test:clean` (`clean → build → test`), which
CI uses so a fresh checkout can never depend on stale `dist` files.
`npm test` (build + test) remains the local convenience form.

### Coverage gate with rising thresholds

`npm run check:coverage` runs the suite with V8 coverage via the node:test
lcov reporter (the default TAP coverage printer crashes on this tree on
Node 22) and enforces thresholds (75% lines / 70% branches / 80% functions at
adoption; baseline measured 78.7 / 76.8 / 83.7). Thresholds exist to prevent
regression and must be raised over time — never lowered to make a change pass.
Override temporarily via `COVERAGE_*` env vars only with a documented reason.

### Dead-code detection

`npm run check:deadcode` (knip) fails CI on unused files, unused/unlisted
dependencies, and dependency cycles. Unused *export* findings are advisory
(`--include` deliberately excludes `exports/types`): tests consume the
compiled artifact at runtime, so knip cannot see that usage, and the barrel
re-export surfaces (`src/security/index.ts` etc.) are intentional public API.
Dead files and dependencies, however, are actionable and blocking.

### Lint scope

ESLint gains `eslint-plugin-security` (server-side rules; the noisy
object-injection / fs-filename rules are disabled with rationale in
`eslint.config.js` — the SSRF policy and validation layer are the real
guards) and `eslint-plugin-import` (order, duplicates, extraneous-dependency
boundaries). Warnings are visible but non-blocking; errors block.

### Pre-commit hooks

`npm run prepare` sets `core.hooksPath` to `.githooks/`. The pre-commit hook
runs the fast subset on staged changes: secret scan, Prettier, ESLint (src),
and `tsc --noEmit`. Bypass with `--no-verify`; CI still enforces everything.

### Performance/load tests

`scripts/perf/load.js` (`npm run perf`) boots the compiled server against the
hermetic fake upstreams used by the e2e suite and drives closed-loop load
(aggregate, waterfall, cache-effectiveness, range scenarios) reporting
latency percentiles. It is not a CI gate; run it before releases and when
changing the request path. It already paid for itself: it exposed a
provider-subtitle semaphore deadlock (fixed in Phase 9, regression test in
`test/concurrency.waterfall.test.js`).

## Consequences

- CI runs: secret scan → test:clean → dead-code gate → coverage gate →
  format check → lint, from a clean checkout.
- The known broken-assumption risks (stale dist, secret leakage, dead deps,
  coverage erosion) are gated mechanically.
- knip's export findings still require periodic human review.

## Limitations

- No browser-level admin UI tests (public/admin is plain JS, out of tsc scope).
- The perf harness measures a single instance with loopback fakes; absolute
  numbers are for regression comparison, not capacity planning.
- Container/image gates arrive with Phase 10 (build/SBOM/scan).
