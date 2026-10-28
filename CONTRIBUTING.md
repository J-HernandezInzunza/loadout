# Contributing to Loadout

## Setup

| Tool | Version | How |
|---|---|---|
| Node | **22.22.3 or newer** (enforced: `npm install` fails on older) | `nvm install` reads `.nvmrc` |
| Rust | pinned in `rust-toolchain.toml` | install [rustup](https://rustup.rs); it picks the version up |
| git | any recent | Xcode Command Line Tools or Homebrew |

```bash
nvm use
npm ci
cargo fetch --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The first `npm run check` compiles Tauri's Rust dependencies (a few minutes). Later runs take seconds.

## The gate: `npm run check`

Nothing merges unless this is green. It runs four checks in order and stops at the first failure:

| Script | Runs | Catches |
|---|---|---|
| `typecheck` | `tsc -b` and `vue-tsc` | type errors |
| `lint` | ESLint | rule breaks, including the import boundary: `packages/core` may not import Vue, Pinia, Tauri or Node built-ins (it runs in the webview, behind the `Host` port) |
| `test` | Vitest, every `*.test.ts` | behavior against the spec and the golden fixtures |
| `cargo:check` | `cargo check --locked --offline` | Rust errors and invalid Tauri config or capabilities |

`npm run check:offline` runs the same gate in a macOS sandbox with the network blocked
(`tools/offline.sb`). Tests must never reach the network: git tests use local `file://` repos.

## CI

`.github/workflows/ci.yml` runs on every pull request to `main` and every push to `main`, on a
clean macOS machine. It downloads and builds dependencies first, then runs
`npm run check:offline`. On a PR it shows as **CI / Typecheck, lint, test, cargo check (offline)**.
To run it by hand: Actions tab → CI → Run workflow (only for workflows already on `main`).

## Repository layout

```
packages/core/        @loadout/core: all domain logic, UI-free
packages/host-node/   the Host port on Node (tests, future agent host)
apps/desktop/         Vue 3 UI + host-tauri; src-tauri/ is the Rust shell (plugins only)
tools/golden/         dev-only Python harness that regenerates golden fixtures from the old CLI
docs/spec/            the spec: behaviors.md (rules by id), architecture.md, open-questions.md
docs/PLAN.md          the task list for milestones M1 to M3
```

`docs/spec/` is the source of truth. A rule id in a test name (`EDIT-08`, `RES-02`) points at
`docs/spec/behaviors.md`; where a rule and its `(rebuild, §0.1: …)` note disagree, the note wins.

## Commits

Semantic messages (`feat(core): …`, `fix(build): …`, `docs(spec): …`, `ci: …`), test-first.
