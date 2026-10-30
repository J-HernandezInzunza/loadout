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

Nothing merges unless this is green. It runs five checks in order and stops at the first failure:

| Script | Runs | Catches |
|---|---|---|
| `typecheck` | `tsc -b` and `vue-tsc` | type errors |
| `lint` | ESLint | rule breaks, including the import boundary: `packages/core` may not import Vue, Pinia, Tauri or Node built-ins (it runs in the webview, behind the `Host` port) |
| `test` | Vitest, every `*.test.ts` | behavior against the spec and the golden fixtures |
| `cargo:check` | `cargo check --locked --offline` | Rust errors and invalid Tauri config or capabilities |
| `cargo:test` | `cargo test --locked --offline` | the Rust unit tests (PATH repair for a Finder-launched app) |

`npm run check:offline` runs the same gate in a macOS sandbox with the network blocked
(`tools/offline.sb`). Tests must never reach the network: git tests use local `file://` repos.

## CI

`.github/workflows/ci.yml` runs on every pull request to `main` and every push to `main`, on a
clean macOS machine. It downloads and builds dependencies first, then runs
`npm run check:offline`. On a PR it shows as **CI / Typecheck, lint, test, cargo check and test (offline)**.
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

## Releasing

Releases are cut from `main` by the owner. How the pieces fit: a `v<version>` tag runs
`.github/workflows/release.yml` (tag check, the gate, then a **draft** release with the `.dmg` and its
`.sha256`); publishing the draft runs `.github/workflows/tap.yml`, which points the cask in
[J-HernandezInzunza/homebrew-tap](https://github.com/J-HernandezInzunza/homebrew-tap) at it. A
pre-release (a version with a `-`, like `0.1.0-rc.1`) never reaches the tap.

Both workflows run in the `release` environment, which holds `LOADOUT_GITHUB_CLIENT_ID`,
`LOADOUT_BITBUCKET_CLIENT_ID`, `LOADOUT_BITBUCKET_CLIENT_SECRET` and `TAP_TOKEN` (a fine-grained token
with contents read and write on the tap repository only; when it expires, the tap job fails on push).
Only the repository admin can create, move or delete `v*` tags (the "release tags" ruleset).

### 1. The version PR

```sh
git switch -c release/v0.1.0 origin/main
npm run version:set 0.1.0
npm run check
git commit -am "chore(release): 0.1.0"
```

Open the PR to `main` with the `skip-changelog` label, and merge it when CI is green. Label the
other PRs going into the release (`enhancement`, `bug`, `documentation`, `chore`, or `skip-changelog`):
the notes are grouped by label.

### 2. Tag

```sh
git switch main && git pull
git tag -a v0.1.0 -m "Loadout 0.1.0"
git push origin v0.1.0
```

Watch Actions → Release. If **Tag matches the version** fails, the tag isn't `v` plus the version in
`apps/desktop/package.json`: delete the tag (step 6) and tag the right commit.

### 3. Check the draft

In Releases, open the draft `Loadout v0.1.0`:

- Assets: `Loadout_0.1.0_aarch64.dmg` and `Loadout_0.1.0_aarch64.dmg.sha256`. Download both and run
  `shasum -a 256 -c Loadout_0.1.0_aarch64.dmg.sha256`.
- Install that `.dmg`, run the `xattr` step from the README, and open it: the sidebar's foot shows
  `Version 0.1.0`; sign in and install a skill.
- Notes: the summary on top, then the PRs by label. Edit **Known issues** if anything is known.

### 4. Publish

Publish the draft. A pre-release stays marked as one and the tap doesn't change. For a release,
Actions → Tap pushes `loadout 0.1.0` to the tap; then on a Mac that has it installed,
`brew update && brew upgrade --cask loadout` reaches the new version.

### 5. Announce

A short Slack post in the team channel:

> Loadout 0.1.0 is out: <link to the release>
> New: `brew install --cask j-hernandezinzunza/tap/loadout`, then
> `xattr -dr com.apple.quarantine /Applications/Loadout.app`.
> Already have it: `brew upgrade --cask loadout` and the same `xattr` command.
> Bugs: <link to Issues → New issue → Bug report>

### 6. When a release goes wrong

- **Still a draft:** delete the draft (`gh release delete v0.1.0 --yes`) and the tag
  (`git push --delete origin v0.1.0 && git tag -d v0.1.0`), fix on `main`, and tag again.
- **Published:** never move or delete a published tag; people may already have that build. Fix on
  `main` and release the next patch version (`0.1.1`) the same way.
- **Published, but the tap didn't update:** fix the cause (often `TAP_TOKEN`), then re-run the failed
  Tap run from Actions.
