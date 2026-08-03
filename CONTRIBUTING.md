# Contributing to addons-core

This guide covers setup, the commands you will use every day, the Phase 0
quality gates, and where this repository lives in the wider workspace.

`addons-core` is a TypeScript/Node-20+ ESM service built on the public
`@omss/framework` package. It exposes an OMSS-compatible HTTP API and serves
as a backend for the cinflix frontend, but it is an independent project.

## Repository boundary

`addons-core` is a standalone nested Git repository. Its own `.git` history and
`origin` remote are authoritative. Changes are made and reviewed here, in this
directory. The parent workspace, other sibling projects, and the untracked
`pstream-extension/` directory are out of scope and must not be modified.

See `docs/adr/0001-repository-ownership.md` for the full decision record.

## Setup

Prerequisites: Node >= 20, npm >= 9.

```bash
# From this repository root
npm ci               # install exactly the committed dependency versions
cp .env.example .env # create your local configuration
```

Then set the required values in `.env` (for example `TMDB_API_KEY`).

### Secrets

`.env` is git-ignored. Secrets such as API keys, debrid keys, and proxy
credentials belong only in your local `.env` or the deployment secret store.
Never commit them, log them, or paste them into issues, and keep them out of
test fixtures and example files.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the server in watch mode with `tsx` |
| `npm run build` | Compile TypeScript to `dist/` with `tsc` |
| `npm start` | Build, then run `dist/server.js` |
| `npm run serve` | Run the already-built `dist/server.js` |
| `npm test` | Build, then run the `test/` suite with `node --test` |
| `npm run format` | Write Prettier formatting over `src/` |
| `npm run format:check` | Check that `src/` is Prettier-clean |
| `npm run lint` | Run ESLint over `src/` |

## Phase 0 quality gates

The minimum reproducible gates, defined in `docs/adr/0002-phase-0-quality-gates.md`,
are, in order:

```bash
npm ci
npm run build
npm test
npm run format:check
npm run lint
```

Run them from a clean checkout before opening a change. `format:check` and
`lint` must pass without edits being made to your working tree, so format your
files first with `npm run format` and address any lint findings.

## Change and review expectations

- Keep changes small and focused. Formatting-only changes are acceptable but
  should be clearly separate from logic changes.
- Prefer conventional commit messages, for example `feat:`, `fix:`, `chore:`,
  `docs:`, `test:`.
- Update or add tests when you change behavior; do not weaken existing tests.
- Generated output in `dist/`, `node_modules/`, and runtime data under `data/`
  are git-ignored and must not be committed.
- Nothing here is a substitute for a maintainer review before merging.
