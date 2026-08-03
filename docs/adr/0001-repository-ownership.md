# ADR 0001 — Repository ownership and topology

Status: Accepted

## Context

`addons-core` lives inside a larger parent workspace. At the start of Phase 0
the directory is already a nested Git repository with its own `.git`, its own
commit history, and its own `origin` remote. The parent workspace does not
track the contents of this directory.

The delivery plan (Phase 0, section 3.1) asked for an intentional
source-control ownership decision before changing any behavior.

## Decision

Keep `addons-core` as a standalone nested Git repository. Its own history,
branch, and `origin` remote remain authoritative for all changes.

- Source, tests, Docker assets, documentation, the lockfile, and example
  configuration are committed in this repository.
- `.env`, `node_modules`, generated `dist`, runtime data under `data/`, logs,
  and local editor state are excluded by `.gitignore`.
- The parent workspace, sibling projects, and `pstream-extension/` are out of
  scope and must not be modified.
- No migration of the repository is performed, and no claim of one is made.
  This ADR records the existing topology as a deliberate boundary.

## Consequences

- Changes are reviewable and traceable within this repository.
- The parent workspace provides no shared history for this project; releases
  and baselines map to commits in this repository only.
- A future decision to relocate or merge this repository (for example into a
  monorepo) is a separate decision that must be recorded in a new ADR.

## Open decision

None for topology. A maintainer identity for code-owner rules is still open;
see `docs/adr/0002-phase-0-quality-gates.md` and `.github/CODEOWNERS.example`.
