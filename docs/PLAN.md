# Plan: M1 to M6

The task list the M1–M6 loop works through (prompt in START-HERE.md). Rule ids point at
`docs/spec/behaviors.md`; `arch §x` at `docs/spec/architecture.md`; `S1`…`S10` at
`docs/spec/spikes.md`. Where a rule carries a `(rebuild, §0.1: …)` note, the note wins.

**How the loop uses this file**

- Take the first unchecked task whose **Depends** are all checked and that is not marked
  `blocked`. Tasks are ordered so that this picks a sensible next step.
- **Rules** are what the tests must cover. Put each rule id in the `describe`/`it` title of the test
  that covers it (`it("RES-02: a skill wins over a prompt of the same name", …)`): the rule-coverage
  test (M1.01) checks this for every checked task.
- Rules tagged `contract` are tested against the golden fixtures in `packages/core/test/golden/`
  (`rebuild ?? python` for splice cases). Never edit a fixture to make a test pass.
- **Done when** is the exit criterion. `npm run check` green is implied for every task.
- When a task finishes: tick it, commit, add one line to `docs/PROGRESS.md`. When it can't: write
  the question to `docs/QUESTIONS.md` and mark the task `blocked (Q<n>)`.

Conventions every task follows: code in `packages/core/src/<module>/`, tests next to it as
`*.test.ts`; side effects only through `Host` (arch §2.2); decisions are typed results, never
prompts (arch §8.4); no module-level state (arch §8.7); every mutation is a plan/apply pair with a
fingerprint (arch §2.3); error codes come from the one closed enum (M1.02).

Questions for the owner live in `docs/QUESTIONS.md`.

---

## M1. Catalog core

Exit: every M1 task checked; every golden case in `scalar`, `splice`, `source`, `registry` and
`read` passes; every rule listed under M1 has a test. (RES-13 to RES-17 and DEP-09/10 moved to M3,
where pins and authoring live; RCAT-01/03 to M2 with the git client.)

- [x] **M1.01 Rule-coverage test.** `test/rule-coverage.test.ts` parses this file, collects the
  rule ids of every **checked** task, and fails if any id is missing from all `*.test.ts` titles
  under `packages/` and `test/`.
  - Rules: none (tooling)
  - Depends: none
  - Done when: the test passes with no task checked, and fails when a task with an uncovered rule
    id is checked (proved with a fixture copy of this file in the test).

- [x] **M1.02 Model, errors and results.** `model/`: `EntryType`, `Entry`, `Source`, `CatalogRef`,
  `Warning`, `Result<T, E>` with `ok()`/`err()` helpers, and the closed `ErrorCode` enum from arch
  §2.3 (`NOT_FOUND`, `AMBIGUOUS_NAME`, `AMBIGUOUS_CATALOG`, `READ_ONLY`, `LOCAL_SOURCE_REFUSED`,
  `SOURCE_IN_INSTALL_DIR`, `DUPLICATE`, `SPLICE_UNSUPPORTED`, `MULTILINE_VALUE`,
  `NO_WRITABLE_CATALOG`, `INVALID_REF`, `STALE_PLAN`, `REFUSED`, `VERIFY_FAILED`, `SETTINGS`, …),
  with zod schemas for each type. Adds `zod` to the core.
  - Rules: none (arch §2.3, §8.2, §8.4, §8.5)
  - Depends: M1.01
  - Done when: schemas round-trip a sample of each type; the enum is exported and exhaustive
    (a `switch` over it type-checks with `never`).

- [x] **M1.03 Test sandbox.** `packages/core/test/sandbox.ts`: a Node `Host` (`@loadout/host-node`)
  rooted in a per-test temp dir with its own `home` and `appData`, which fails the test if any fs
  call or process `cwd` escapes the sandbox (the Python suite's `TempTool`, arch §6).
  - Rules: none (arch §6)
  - Depends: M1.02
  - Done when: a test proves an escaping path fails, and temp dirs are removed after each test.

- [x] **M1.04 Golden fixture loader.** Typed readers for the six fixtures; `expected(case)` returns
  `rebuild ?? python`; helpers to replay splice `ops` and to materialize `hash.json` trees in the
  sandbox.
  - Rules: none (arch §3.2)
  - Depends: M1.02
  - Done when: each fixture loads through its zod schema.

- [x] **M1.05 PyYAML scalar quoting.** `catalog/scalar.ts`: `pyyamlInline(value)` reproducing
  `_yaml_inline` (PyYAML's YAML 1.1 implicit resolvers + emitter scalar analysis, single- and
  double-quoted writers for one line); throws `MULTILINE_VALUE`.
  - Rules: EDIT-02, EDIT-03
  - Depends: M1.04
  - Done when: all 4,693 cases in `scalar.json` match byte for byte, and every `multiline` case
    throws `MULTILINE_VALUE`.

- [x] **M1.06 Render entry and ref validation.** `catalog/splice.ts` `renderEntry(e)`;
  `validateRef(ref)`: `type:name` with type in skill/agent/prompt, and no `"`, `\` or control
  characters (A11).
  - Rules: EDIT-01, DEP-11
  - Depends: M1.05
  - Done when: every `render/*` case in `splice.json` matches (`rebuild` for the three refused refs).

- [x] **M1.07 Splice: insert into existing sections.** Port `_locate_section`, `_item_starts`,
  `spliceEntry` line for line (`text.split("\n")`, rejoin with `"\n"`); batch add applies it in order.
  - Rules: EDIT-04, EDIT-06, EDIT-07, EDIT-08, EDIT-13
  - Depends: M1.06
  - Done when: every splice-only case in `splice.json` whose expectation is `python` passes.

- [x] **M1.08 Splice: unsupported layouts (D2).** Layout check before any edit; `SPLICE_UNSUPPORTED`
  with the 1-based line.
  - Rules: EDIT-09
  - Depends: M1.07
  - Done when: every case whose expectation is a `SPLICE_UNSUPPORTED` error passes (code and line).

- [x] **M1.09 Splice: create missing sections (D1).**
  - Rules: EDIT-05
  - Depends: M1.08
  - Done when: every case whose input lacks the target section passes.

- [x] **M1.10 Remove (D3).** `removeEntry(text, type, name)`.
  - Rules: EDIT-10, EDIT-11
  - Depends: M1.08
  - Done when: every case containing a `remove` op passes, round trips included.

- [x] **M1.11 Replace (D4).** `replaceEntry(text, type, name, entry)`.
  - Rules: EDIT-12
  - Depends: M1.08
  - Done when: every case containing a `replace` op passes; together with M1.07–M1.10, all 896
    splice cases pass.

- [x] **M1.12 Catalog read.** `catalog/read.ts`: `parseCatalog(text)` with `yaml` (eemeli) in YAML
  1.1 mode; `catalogEntries(data, catalogId)` in section order skills, agents, prompts; field
  validation the CLI lacks: a non-string `name`/`description`/`source`, or a `requires` that is not
  a list of strings, is a typed per-entry problem, not a crash (the CLI turns `requires: skill:b`
  into a list of characters). `verifyEdit(newText, entry, present)` for WRITE-16. `sortedProblems`
  for doctor.
  - Rules: RES-02, WRITE-16, EDIT-14
  - Depends: M1.04
  - Done when: every `read.json` case parses to the same values as PyYAML (strings equal; each
    `{py, repr}` value maps to its declared TS form and is reported as a field problem), and every
    `read.json` error case is a typed parse problem.

- [x] **M1.13 Catalog scaffold.** `scaffoldCatalog(id)`: a text the splice accepts (EDIT-15's
  comments may mention Loadout instead of the CLI).
  - Rules: EDIT-15
  - Depends: M1.07
  - Done when: the scaffold parses to three empty sections and accepts an insert into each.

- [x] **M1.14 Source parsing.** `source/`: `parseSource`, `cloneUrls`, `remoteWeb`; `~` expands
  against `host.paths.home`.
  - Rules: FETCH-01
  - Depends: M1.04
  - Done when: every `source.json` case matches, with `/home/golden` substituted for the sandbox home.

- [x] **M1.15 Config store.** `config/`: `AppConfigV1` zod schema (arch §4.1 as amended: no
  `autopush`, `defaultAddCatalog`, `installDirs`, `gitCommit`), `loadConfig()` returning a typed
  "no catalogs registered" state, `saveConfig()` through `writeTextAtomic`, writes serialized
  through an in-process queue.
  - Rules: LOCK-01
  - Depends: M1.03
  - Done when: round trip; an invalid file is a typed error and is never overwritten; two
    concurrent saves both land in order.

- [x] **M1.16 Registry validation.** `validateRegistry(raw)`, the port of `Config.problems`.
  - Rules: MIG-01
  - Depends: M1.12
  - Done when: every `registry.json` case yields the same problem list, in the same order.

- [x] **M1.17 One-time import.** `planImport(toolDir?)` / `applyImport(plan)`: find the tool dir
  through the `~/.claude/skills/library` symlink (or take one); parse `config.local.yaml` (YAML 1.1);
  refuse when `validateRegistry` reports problems; normalize the legacy `catalog:` form; map
  catalogs (with explicit `protected`, `writable`) and pins; report, without importing,
  `autopush`, `default_add_catalog`, `default_dirs`, `git_commit`, unknown keys and quoted
  booleans (read strictly); remember `<tool dir>/.installs.json` as a classification hint; apply
  writes `config.json` with `imported` and never touches the old file.
  - Rules: MIG-01, MIG-03
  - Depends: M1.15, M1.16
  - Done when: the normalized catalogs match `registry.json`'s `catalogs` for every valid case;
    `quoted-false-flags` reports each coerced flag and imports `false`; the old file's bytes are
    unchanged after apply.

- [x] **M1.18 Registry.** `registry/`: `Registry` over config + catalog data: `active()`,
  `writable()`, `entries()`, `entriesOf(id)`, skip reasons (local file unreadable; remote clone
  absent at `clones/<id>` → "not cloned yet"); loading never touches the network.
  - Rules: RCAT-02, RCAT-08, RCAT-09, RES-18
  - Depends: M1.12, M1.15
  - Done when: one unreadable catalog of several is skipped with its reason while the others serve;
    a single unreadable catalog and an all-unreadable registry report as RCAT-08 describes.

- [x] **M1.19 Name resolution.** `resolve(name, catalog?)`, precedence, pins, `winners()`,
  `candidates(query)`, and resolve-all-before-effect for multi-name requests.
  - Rules: RES-01, RES-02, RES-03, RES-04, RES-05, RES-06, RES-10, RES-11
  - Depends: M1.18
  - Done when: each rule has a test; `NOT_FOUND`/`AMBIGUOUS_NAME` carry candidates.

- [x] **M1.20 Override provenance.** `overrideSplit(entry)`, `overrides`/`overriddenBy`/`pinned`
  on records, per item for multi-name requests (A27).
  - Rules: RES-07, RES-08, RES-09, RES-12
  - Depends: M1.19
  - Done when: each rule has a test (install fields are stubbed until M2.20).

- [x] **M1.21 Dependencies.** `deps/`: `resolveDeps` (post-order, own catalog only), `dependents`,
  `findCycles`; a cycle records the parent that re-entered it (A29); `not_found` and `malformed`
  share one wording (A25).
  - Rules: DEP-01, DEP-02, DEP-03, DEP-04, DEP-05, DEP-06, DEP-08
  - Depends: M1.19
  - Done when: each rule has a test.

- [x] **M1.22 Library facade and reads.** `ops/`: `createLibrary(host)`; `list`, `show`,
  `catalogs`, `search` (W18) with catalog-level fields; input/output zod schemas per op.
  - Rules: RES-04, UPD-07
  - Depends: M1.20, M1.21
  - Done when: two `createLibrary` instances share no state; `show` of an unknown name returns
    `NOT_FOUND` with candidates; `search` matches name or description, case-insensitively.

---

## M2. Install and lifecycle

Exit: every M2 task checked; hermetic git tests pass against `file://` repos; the toggle tests
cover arch §4.5 rules 1–7.

- [x] **M2.01 Git test harness.** Bare repos under the sandbox served as `file://` URLs; a test-only
  `GIT_CONFIG_GLOBAL` with `url.<file://…>.insteadOf` for the https forms of github.com and
  bitbucket.org (ssh forms deliberately unmapped, so the ssh→https fallback runs);
  `GIT_ALLOW_PROTOCOL=file`; helpers to create repos, commit trees and move branches.
  - Rules: none (arch §6)
  - Depends: M1.03
  - Done when: `git clone --depth 1` of `https://github.com/o/r.git` clones the local repo, and a
    clone of any unmapped URL fails without network access.

- [x] **M2.02 Host secrets and HTTP ports.** Add `HostSecrets` (`get`/`set`/`delete`) and
  `HostHttp` (`request`) to the `Host` interface as in arch §2.2; the Node host implements secrets in
  memory (one store per host instance) and HTTP with `fetch` (timeouts and `AbortSignal`); the Tauri
  stub rejects both until M4.
  - Rules: none (arch §2.2, §5.5)
  - Depends: M1.03
  - Done when: the Node host's tests cover both ports, including an aborted and a timed-out request.

- [x] **M2.03 Host API stub.** A local HTTP server for tests that fakes the GitHub and Bitbucket
  endpoints Loadout uses (current user, Bitbucket token refresh, PR create and list, with a duplicate
  answering as each host does), records every request, and can be told to fail; API base URLs are
  injectable in the core for tests only.
  - Rules: none (arch §6)
  - Depends: M2.02
  - Done when: a test drives each endpoint through `Host.http` and reads back the recorded requests.

- [x] **M2.04 Accounts.** `accounts/`: `connect(host, tokenSet)` (what the M4 sign-in flows call),
  `disconnect(host)`, `accounts()`, and `tokenFor(host)`, which refreshes an expired Bitbucket token
  with its refresh token first; tokens only in `Host.secrets`, non-secret facts (login, scopes,
  connected-at) in `config.json`; `whoami` validates a token. No OAuth flow here (M4).
  - Rules: none (arch §5.5)
  - Depends: M2.03, M1.15
  - Done when: connect, refresh, disconnect and an invalid token have tests against the stub; no token
    appears in `config.json` or in any audit event.

- [x] **M2.05 Git client.** `git/`: `GitClient` over `HostProc`: non-interactive env, timeouts and
  `AbortSignal` on every network call, clone (ssh then https, fresh dir per attempt, A30),
  `lsRemoteHead` on `refs/heads/<branch>` exactly (A5), `probeOid` (blobless no-checkout clone +
  `rev-parse`), `revParse`, `pullFfOnly`, `behindCount` returning "unknown" when it could not
  fetch (A6), error summaries that keep the ssh reason (A31). Never writes to a child's stdin (S1).
  For a host with a connected account: https first, with the token passed through a per-command
  credential helper and environment variables (arch §5.5), never in argv, a remote URL or the audit log.
  - Rules: FETCH-02, FETCH-03, UPD-01, UPD-02
  - Depends: M2.01, M2.04
  - Done when: each rule has a test against the harness; a branch `feature/main` never answers for
    `main`; a clone with an injected token succeeds against a `file://` remote that requires the
    helper's credentials, and `.git/config` and the audit log never contain the token.

- [x] **M2.06 Per-operation caches and temp dirs.** `CloneCache` keyed `<kind>:<org>/<repo>@<branch>`,
  `ProbeCache` memoizing failures, `tmp/<op id>/` per operation, removed at the end and swept at
  launch.
  - Rules: FETCH-04, FETCH-09
  - Depends: M2.05
  - Done when: two entries from one repo+branch clone once; a killed operation's temp dir is gone
    after the next launch sweep.

- [x] **M2.07 Content hashing.** `contentHashV1(path)` (the CLI's algorithm, for classifying
  Python-CLI installs) and `fileManifest(path)` (posix relpath → sha256, receipts v2).
  - Rules: none (arch §4.3, §4.4)
  - Depends: M1.04
  - Done when: every `hash.json` tree, materialized in the sandbox, gives the recorded digest.

- [x] **M2.08 Receipts v2.** `receipts/`: `ReceiptStore` (`get`, `put`, `delete`, `all`), file
  sorted by dest, atomic writes behind an in-process queue (A32); an unknown version reads as empty
  and is never overwritten silently.
  - Rules: LOCK-02
  - Depends: M2.07, M1.15
  - Done when: 50 concurrent `put`s all survive; a crash mid-write (simulated) leaves the old file.

- [x] **M2.09 Persistent catalog clones.** `catalogs/`: `refreshCatalogs()` (absent → shallow
  single-branch clone into `clones/<id>`; present → `pull --ff-only`), per-catalog warnings instead
  of failing (A3), origin check before reusing a clone dir (A20), `catalogStatus` with behind
  count or "couldn't check", diverged-clone detection (A4); reads never pull (R12).
  - Rules: RCAT-01, RCAT-03, RCAT-04, RCAT-05, RCAT-06, RCAT-07, RCAT-10
  - Depends: M2.05, M1.18
  - Done when: each rule has a test (RCAT-05 tests the fix: an unclonable catalog is skipped and the
    others still serve).

- [x] **M2.10 Scan.** `scan/`: `destState(dest)` and `scanInstallDirs()` over the fixed install
  dirs (top level only, R9): managed (`installed`/`drifted` with per-file edits), unmanaged with
  origin (`python-cli`, `python-cli-edited`, `parked-by-python-cli`, `symlink`, `foreign`),
  missing; skips dot names and `synced`.
  - Rules: INST-01, SCAN-01, INST-08, SYNC-06
  - Depends: M2.07, M2.08
  - Done when: each origin has a test; a symlink is reported and never followed.

- [x] **M2.11 Fetch sources.** Remote and local fetch into the op's cache: file must exist
  (FETCH-05), skill = its folder (FETCH-06), local sources (FETCH-07), overlap refusal (FETCH-08),
  repo-root skills copied without `.git` (FETCH-10 rebuild), directory sources install the parent
  (FETCH-11), verification in staging (FETCH-12 rebuild: `SKILL.md` or the `.md` file must exist,
  else `VERIFY_FAILED`).
  - Rules: FETCH-05, FETCH-06, FETCH-07, FETCH-08, FETCH-10, FETCH-11, FETCH-12
  - Depends: M2.06
  - Done when: each rule has a test.

- [x] **M2.12 Update detection.** `sourceUnchanged`, `contentUnmoved`, stale detection; advancing
  a receipt's commit when the head moved but the content did not.
  - Rules: UPD-03, UPD-04, UPD-05, UPD-06, UPD-08
  - Depends: M2.11, M2.08
  - Done when: each rule has a test; a repointed source never borrows an oid.

- [x] **M2.13 Plan install.** `planInstall({ names, catalog? })`: resolve all names first, merge
  dependency closures, fetch into the cache, compute a per-destination file-level preview (added,
  removed, modified, and which modified files the user edited locally), mark unmanaged destinations
  as needing consent (Q8 A), mark unreachable items, fingerprint the plan; offline falls back to a
  destination-only preview (Q5 A). An off skill installs normally (DEP-07 rebuild).
  - Rules: RES-05, DEP-06, DEP-07, INST-02, INST-03, INST-05
  - Depends: M2.10, M2.12, M1.22
  - Done when: each rule has a test; per-item override provenance is present (A27).

- [x] **M2.14 Apply install.** `applyInstall(plan, { overwrite })`: re-check the fingerprint
  (`STALE_PLAN`), stage into `tmp/` and rename into place (R14), write a v2 receipt per dest, stop
  at the first failure keeping earlier items, report progress, honor abort, audit each destructive
  fs op. An off skill stays off.
  - Rules: INST-04, INST-06, INST-07
  - Depends: M2.13
  - Done when: each rule has a test; an install interrupted mid-copy leaves the old copy intact.

- [x] **M2.15 Claude settings file.** `claudeSettings/`: `readSkillOverrides()`, and the minimal
  JSON edit with `jsonc-parser` (`modify` + `applyEdits`): refuse unparseable JSON, preserve
  formatting byte for byte outside the key, keep the mode, write next to the **real** file so a
  symlink stays a symlink, re-read and retry once if the file changed, create
  `{"skillOverrides": {…}}` only when the file is missing, honor `CLAUDE_CONFIG_DIR`.
  - Rules: none (arch §4.5 rules 2, 3; its "Tests" paragraph)
  - Depends: M1.03
  - Done when: the six cases in arch §4.5 "Tests" pass (formatting preserved, missing file, empty
    object, invalid JSON refused, symlink preserved, concurrent change detected), plus
    `CLAUDE_CONFIG_DIR`.

- [x] **M2.16 Toggle skills and prompts.** `setSkillState(names, "on" | "off")`: key = entry name
  (rule 1, S10); `"on"` deletes the key; skills and prompts only, agents refused (Q15 A); works for
  unmanaged items (rule 6); `name-only`/`user-invocable-only` reported read-only (Q14 A); a
  report of managed-settings overrides for doctor (rule 4).
  - Rules: none (arch §4.5 rules 1, 4, 5, 6)
  - Depends: M2.15, M2.10
  - Done when: each listed rule of arch §4.5 has a named test.

- [x] **M2.17 Migrate parked copies.** `planMigrateParked()` lists every copy in
  `~/.claude/skills-disabled/`; `applyMigrateParked(plan)` moves each back (rename, or on `EXDEV`
  copy-verify-delete) and writes `"off"`; an occupied destination is left alone and reported.
  The app never writes into `-disabled` folders otherwise.
  - Rules: none (arch §4.5 rule 7, Q16 B; DIS-03's copy-verify-delete)
  - Depends: M2.16
  - Done when: rule 7 has a test, including a simulated `EXDEV` and an occupied destination.

- [x] **M2.18 Uninstall.** `uninstall({ names, forcePaths })`: global destinations only, refuse an
  unmanaged destination unless its exact path is in `forcePaths`, prune receipts of absent dests,
  delete the skill's override and report it (Q17 A).
  - Rules: UNIN-01, UNIN-02
  - Depends: M2.14, M2.16
  - Done when: each rule has a test.

- [x] **M2.19 Sync.** `planSync` / `applySync`: winning copies of managed installs, dependency
  closures, skip when `sourceUnchanged` (unless `force`), unmanaged items skipped and reported
  (A2), per-item failures, missing receipts reported, off skills refreshed in place.
  - Rules: SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06
  - Depends: M2.14
  - Done when: each rule has a test (SYNC-03 tests the fix).

- [x] **M2.20 Install state in reads.** `list`/`show` gain `installed`, `state`, `receipt`,
  `locations`, `disabled` (from overrides); `list({ checkRemote })` computes `stale`; `show`
  installs are filtered by type (A26); `scan()` and `refresh()` on the facade.
  - Rules: RES-07, RES-08, UPD-06, UPD-07
  - Depends: M2.13, M2.16, M2.09
  - Done when: each rule has a test.

- [x] **M2.21 Register and unregister catalogs.** `planAddCatalog`/`applyAddCatalog` (clone or
  read to prove it works, `protected` stored explicitly, A21), `initCatalog` (scaffold; a path
  without `.yaml` gets `library.yaml` appended, A18), `removeCatalog` (purge clone; purge installs,
  global only, A19).
  - Rules: RCAT-01, EDIT-15
  - Depends: M2.09, M1.13
  - Done when: each op has a test for its happy path and each listed fix.

- [x] **M2.22 Doctor.** `doctor({ deep })` with the §2.10 checks tagged `mvp` (3, 4, 7–11, 13–31),
  plus: `git --version`, `xcode-select -p`, for each host with a protected catalog a connected
  account whose token still works (replaces check 11; arch §5.3, §5.5),
  managed-settings overrides of catalog skills (arch §4.5 rule 4), diverged clones with a re-clone
  action (A4), unmanaged copies of catalog entries (replacing checks 30–31's wording).
  - Rules: EDIT-14, DEP-04, DEP-05, RCAT-07
  - Depends: M2.20, M2.21
  - Done when: each kept check has a test that triggers it.

- [x] **M2.23 Bitbucket and real-remote smoke (manual).** Run install, sync and doctor against the
  team catalog on Bitbucket from a Finder-launched dev build; record results in
  `docs/spec/spikes.md` as S11.
  - Rules: none (S1 gap)
  - Depends: M2.22
  - Done via M4.16: spikes.md S11.
  - Done when: S11 is written.

---

## M3. Authoring

Exit: every M3 task checked; WRITE and EDIT rules covered; a PR-mode test checks the branch name,
the commit and the PR API request (START-HERE.md said `gh`'s argv; `gh` was dropped, arch §5.5).

- [x] **M3.01 PR API clients.** `git/pullRequests.ts`: `createPullRequest(host, repo, { base, head,
  title, body })` for GitHub (`POST /repos/{owner}/{repo}/pulls`) and Bitbucket
  (`POST /2.0/repositories/{workspace}/{repo}/pullrequests`) through `Host.http` with the account's
  token; a duplicate resolves to the existing PR's URL (QUESTIONS.md Q2); other failures are typed.
  - Rules: none (arch §5.5)
  - Depends: M2.04
  - Done when: create, duplicate, expired-token-then-refresh and server-error cases pass against the
    stub, for both hosts.

- [x] **M3.02 Write target.** `writeTarget(req)`: explicit catalog (unknown, skipped,
  `writable: false`), no catalog (none writable, one, several → `AMBIGUOUS_CATALOG`), and for
  update/remove the catalog the entry resolved from (`AMBIGUOUS_CATALOG` with holders).
  - Rules: WRITE-01, WRITE-02, WRITE-03, WRITE-04
  - Depends: M1.22
  - Done when: each rule has a test.

- [x] **M3.03 Edit pipeline.** `applyCatalogEdit` core shared by all modes: compute the edit
  against the exact bytes being written (WRITE-15), field-level no-op detection, re-parse and verify
  (WRITE-16), plan fingerprint (`STALE_PLAN`), dry-run unified diff (WRITE-17), result shape
  (WRITE-18), atomic write of the catalog file (A32).
  - Rules: WRITE-15, WRITE-16, WRITE-17, WRITE-18, LOCK-03
  - Depends: M3.02, M1.11
  - Done when: each rule has a test; a file changed between plan and apply returns `STALE_PLAN`.

- [x] **M3.04 Local mode.** Write the file; no git (Q11).
  - Rules: WRITE-14
  - Depends: M3.03
  - Done when: WRITE-14 has a test; the result reports `committed: false`, `pushed: false`.

- [x] **M3.05 Direct mode.** Refresh the clone, edit it, commit, `push origin HEAD:<branch>`;
  commit or push failure is a warning and the result says so; a rejected stale push leaves the
  clone for doctor's re-clone (A4, S4).
  - Rules: WRITE-13, WRITE-09
  - Depends: M3.03, M2.09
  - Done when: each rule has a test against the harness, including a stale push.

- [x] **M3.06 PR mode.** Temp single-branch clone, branch `library/<op>-<name>-<%Y%m%dT%H%M%S>`
  with a `-2`… suffix on collision, commit, `push -u`, compare URL; then, when an account for the
  catalog's host is connected, open the PR through M3.01 (GitHub and Bitbucket alike), else return the
  manual result with the compare URL; an API failure is a warning with the compare URL; commit and PR
  copy per WRITE-12. Remove `gh` from the shell scope and from `HostProc`'s program type.
  - Rules: WRITE-07, WRITE-08, WRITE-09, WRITE-10, WRITE-11, WRITE-12
  - Depends: M3.03, M3.01
  - Done when: each rule has a test; one test asserts the exact branch name, commit message and the
    recorded PR request; a repeated write returns the existing PR's URL; with no account connected
    the result is manual with the compare URL; `capabilities.test.ts` allows only `git`.

- [x] **M3.07 Suggest source.** `suggestSource(path)`: a GitHub/Bitbucket browser URL for a local
  file inside a git repo with a matching origin (Q13 b).
  - Rules: WRITE-05
  - Depends: M2.05, M1.14
  - Done when: GitHub and Bitbucket origins (ssh and https) produce the right URL; no origin gives
    none.

- [x] **M3.08 Add.** `planAdd` (one entry or a batch, EDIT-13) following behaviors.md §3.12: type
  inferred from the source, source parsed, local source refused for remote catalogs with the
  suggestion (WRITE-05), local source inside an install dir refused (WRITE-06), refs validated
  (DEP-11), duplicates in the batch and the catalog refused, override warnings, unknown-dependency
  warnings (DEP-10), repo-root skill sources and directory sources refused with an explanation
  (Q13 d, A9).
  - Rules: WRITE-05, WRITE-06, DEP-10, DEP-11, EDIT-13
  - Depends: M3.04, M3.07
  - Done when: each rule has a test; a batch of three lands as one write.

- [x] **M3.09 Update.** `planUpdate` per §3.15: edits through `replaceEntry` (D4), name and type
  fixed, `setSource` validated like add, no-op when fields are equal, unknown-dependency warning
  against the fresh text.
  - Rules: EDIT-12, WRITE-15, DEP-10
  - Depends: M3.08
  - Done when: each rule has a test; an update preserves an unknown key end to end.

- [x] **M3.10 Remove.** `planRemove` per §3.14, with the dependents warning and optional purge of
  installed copies.
  - Rules: DEP-09, EDIT-10
  - Depends: M3.04, M2.18
  - Done when: each rule has a test.

- [x] **M3.11 Push.** `planPush` / `applyPush` per §3.16: send an installed copy's edits back to
  its source (local file, or a PR/branch for a remote source); afterwards the receipt describes the
  pushed content, so the copy no longer reads as edited (A28).
  - Rules: none (§3.16; A28)
  - Depends: M3.06, M2.14
  - Done when: local and remote pushes have tests, and the copy reads `installed` after each.

- [x] **M3.12 Pin and unpin.** `planPin` / `applyPin({ switchInstalled })` with the switch
  assessment, and `unpin`.
  - Rules: RES-13, RES-14, RES-15, RES-16, RES-17
  - Depends: M2.20
  - Done when: each rule has a test.

- [x] **M3.13 Milestone check.** Every WRITE and EDIT rule tagged `mvp` appears in a test title;
  `npm run check` green; the deviation report regenerated and unchanged.
  - Rules: none
  - Depends: M3.05, M3.06, M3.09, M3.10, M3.11, M3.12
  - Done when: the rule-coverage test passes with every M1–M3 task checked.

---

## M4. Desktop host and accounts

Exit: every M4 task checked; `createLibrary` exposes every op of arch §2.3 with input/output schemas;
the app, launched from Finder, runs the core on the Tauri host against real remotes (S11); browser
sign-in connects GitHub and Bitbucket accounts. Screens are the next milestone (open-questions.md
"UI"); M4 ships at most a debug view.

Conventions for the host tasks: `apps/desktop/src/host-tauri/` holds one file per port, tested with
`@tauri-apps/api/mocks` (`mockIPC`) asserting the plugin calls (arch §6); Rust stays glue (arch
§2.4); `test/capabilities.test.ts` grows with every scope added.

- [x] **M4.01 Facade: install lifecycle.** `createLibrary` gains `planInstall`/`applyInstall`,
  `uninstall`, `setSkillState`, `planMigrateParked`/`applyMigrateParked`, `planSync`/`applySync` and
  `discardPlan`, with the signatures of arch §2.3. One context per instance (git client, receipts,
  settings, accounts, API bases) built in `createLibrary`; nothing module-level (arch §8.7). Input
  and output zod schemas in `ops/schemas.ts`; plans are opaque in the schema (a branded object the
  caller hands back, never edited).
  - Rules: none (arch §2.3, §8.2, §8.3)
  - Depends: M3.13
  - Done when: each op has a facade test (happy path plus one refusal) on the Node host; two
    instances still share no state.

- [x] **M4.02 Facade: registry, accounts and maintenance.** `pins()` (name, catalog, holders,
  dangling, resolvesTo; §3.6's list), `doctor`, `recloneCatalog`, `planAddCatalog`/`applyAddCatalog`,
  `initCatalog`, `removeCatalog`, `planImport`/`applyImport`, `accounts`/`connect`/`disconnect`.
  - Rules: none (arch §2.3, §5.5; behaviors.md §3.6 list form)
  - Depends: M4.01
  - Done when: each op has a facade test; `pins()` reports a dangling pin (RES-11's inert cases).

- [x] **M4.03 Facade: authoring.** `planAdd`, `planUpdate`, `planRemove` and one
  `applyCatalogEdit(plan)` as arch §2.3 has it (the plan carries its op, so the three `apply*`
  functions become internal); `discardCatalogEdit`; `planPush`/`applyPush`/`discardPush`;
  `planPin`/`applyPin`/`unpin`; `suggestSource`.
  - Rules: none (arch §2.3)
  - Depends: M4.02
  - Done when: each op has a facade test; a PR-mode plan discarded through the facade leaves no temp
    dir.

- [x] **M4.04 Facade contract.** A test lists the `Library` interface's methods (TypeScript compiler
  API, as `rule-coverage.test.ts` reads titles) and fails if one lacks an exported input or output
  schema (arch §8.2); every result's warnings and error codes parse against `Warning`/`CoreError`.
  An in-memory `Library` fake for the UI tests (arch §6) implements the same interface.
  - Rules: none (arch §6, §8)
  - Depends: M4.03
  - Done when: removing any schema export fails the test; the fake type-checks against `Library`.

- [x] **M4.05 Launch.** `library.launch({ signal })`: `sweepTemp`, load config (the typed
  "no catalogs registered" state), refresh catalogs (warnings per catalog, A3), and report what it
  did; reads before it finishes use the clones on disk (W14).
  - Rules: none (arch §2.5 refresh policy, §5.4; M2.06's launch sweep)
  - Depends: M4.04
  - Done when: a killed operation's temp dir is gone after `launch`, and an offline launch returns
    warnings, not an error.

- [x] **M4.06 Tauri host: fs.** `HostFs` over `@tauri-apps/plugin-fs`: `writeTextAtomic` (temp in
  the same dir + rename), `rename` rejecting `{ code: "EXDEV" }` across volumes, `lstat` that
  doesn't follow links, `makeTempDir` under `<appData>/tmp`. Capability: arch §2.4 option 1
  (`$HOME/**` with the eight denies, `$APPDATA` and `$APPDATA/**`,
  `requireLiteralLeadingDot: false`, S3a).
  - Rules: none (arch §2.2, §2.4; S3, S3a)
  - Depends: M4.05
  - Done when: each method has a `mockIPC` test; the capabilities test fails if a deny is dropped or
    the scope widens past `$HOME`/`$APPDATA`.

- [x] **M4.07 Tauri host: proc, paths, hashing, audit.** `HostProc` over the shell plugin's
  `Command` for `git` only: cwd, env, timeout and `AbortSignal` both kill the child, `durationMs`;
  `paths.home`/`appData` from `@tauri-apps/api/path`; `sha256` via `crypto.subtle`; `audit` into an
  in-memory ring buffer the UI will subscribe to (arch §2.5), with proc start/end events.
  - Rules: none (arch §2.2, §2.5; S1, S2)
  - Depends: M4.06
  - Done when: `mockIPC` tests cover a timeout and an abort killing the child; the audit buffer never
    holds an env value (tokens travel in env, arch §5.5).

- [x] **M4.08 Keychain secrets.** Rust `secret_get`/`secret_set`/`secret_delete` with the `keyring`
  crate (service `com.jhernandezinzunza.loadout`, account `<host>`), the one exception to "no
  commands" (arch §2.4); `HostSecrets` in host-tauri invokes them.
  - Rules: none (arch §5.5)
  - Depends: M4.07
  - Done when: `cargo test` covers the three commands against keyring's mock store; a `mockIPC`
    test covers the TS side; the capabilities file allows only these three commands (and M4.06's
    `real_path`, Q6).

- [x] **M4.09 HTTP.** Add `tauri-plugin-http`; `HostHttp` over its `fetch` with timeout and
  `AbortSignal`; scope exactly `https://api.github.com/*`, `https://github.com/login/*`,
  `https://api.bitbucket.org/*`, `https://bitbucket.org/site/oauth2/*` (arch §2.4).
  - Rules: none (arch §2.2, §2.4, §5.5)
  - Depends: M4.07
  - Done when: `mockIPC` tests cover a timeout and an abort; the capabilities test fails on any other
    URL in the scope.

- [x] **M4.10 PATH cache.** In Rust `main`, before plugins start: use the PATH (and
  `CLAUDE_CONFIG_DIR`) cached in app data at once; probe the login shell in the background (10 s
  timeout, shell PATH first, S2) and write the cache for the next launch; probe inline only when
  there is no cache yet.
  - Rules: none (arch §5.3; Q4)
  - Depends: M4.07
  - Done when: `cargo test` covers cache hit, cache miss, a probe timeout and a corrupt cache file;
    launch time with a warm cache doesn't wait on the shell.

- [x] **M4.11 App wiring and debug view.** `main.ts` builds the Tauri host and one `createLibrary`
  instance, runs `launch`, and shows a throwaway debug view (catalogs, entries with install state,
  the audit log) to prove the host end to end; `apps/desktop/src/spike/` is removed.
  - Rules: none (arch §2.5)
  - Depends: M4.05, M4.06, M4.07, M4.08, M4.09, M4.10
  - Done when: a dev build launched from Finder lists the registered catalogs and their entries, and
    the audit log shows the launch's git calls.

- [x] **M4.12 OAuth redirect spike.** Can both hosts redirect to `loadout://oauth/…` through
  `tauri-plugin-deep-link`, or does one need a one-shot loopback listener? GitHub device flow needs
  no redirect; check whether it is enough on its own. Record the answer as S12 in
  `docs/spec/spikes.md`.
  - Rules: none (arch §5.5)
  - Depends: M4.11
  - Done when: S12 is written with the chosen redirect per host.

- [x] **M4.13 GitHub sign-in.** The flow S12 chose (device flow by default), ending in
  `accounts.connect("github", tokenSet)` (M2.04); cancellable; a denied or expired authorization is
  a typed error.
  - Rules: none (arch §5.5)
  - Depends: M4.12
  - Done when: the flow's HTTP exchanges are tested against an extended API stub (M2.03); a manual
    sign-in connects a real account.

- [x] **M4.14 Bitbucket sign-in.** Authorization-code flow with the redirect S12 chose; the consumer
  key and secret come from build-time environment variables (a GitHub Actions secret in release
  builds, never committed, arch §5.5 and §10 risk 13); ends in `accounts.connect("bitbucket",
  tokenSet)` with the refresh token, which M2.04 already uses.
  - Rules: none (arch §5.5)
  - Depends: M4.12
  - Done when: the exchange and a refresh are tested against the stub; a build without the
    variables reports Bitbucket sign-in as unavailable instead of failing; a manual sign-in connects
    a real account, and Loadout then comes to the front saying who is signed in and that the browser
    tab can be closed (S12: the tab stays on the consent page).

- [x] **M4.15 Accounts in the debug view.** Connect, disconnect and "token still works" for both
  hosts, through the facade (M4.02).
  - Rules: none (arch §5.5)
  - Depends: M4.13, M4.14
  - Done when: a manual run connects and disconnects each host, and `config.json` and the audit log
    never hold a token.

- [x] **M4.16 Real-remote smoke (manual; replaces M2.23).** From a Finder-launched dev build: install,
  sync and doctor against the team catalog on Bitbucket, and one PR-mode write (with an account
  connected if M4.15 is done, else the compare URL); record results in `docs/spec/spikes.md` as S11.
  - Rules: none (S1 gap)
  - Depends: M4.11
  - Done when: S11 is written and M2.23 is checked with a pointer to it.

- [x] **M4.17 Milestone check.** `npm run check` green; the facade contract test passes; the
  capabilities test covers fs, shell, http and the three commands.
  - Rules: none
  - Depends: M4.11, M4.15, M4.16
  - Done when: every M4 task is checked.

---

## M5. Screens: parity with the old app

Exit: every M5 task checked; the old app's screens, wording and design tokens run on the M4 facade
(open-questions.md Q9 A), with the §4.10 gaps fixed; every UI rule tagged `mvp` (UI-01…UI-55, less
the `drop`/`later` ones: UI-06, UI-07, UI-33, UI-40, UI-56) appears in a test title; every old spec
file (`the-library-skill/desktop/src/**/*.spec.ts`, 31 files) is ported or listed as dropped with its
reason; the debug view is gone. New surfaces wait for M6.

Conventions for the screen tasks: components in `apps/desktop/src/components/`, one Pinia store per
area (arch §2.5: catalog, install, registry, activity, plus the view stack), tests next to each
component as `*.test.ts` against the `@loadout/core/testing` fake, which grows stateful mutations as
each screen needs them (never IPC mocks above the host layer). A screen task ports its old specs'
assertions with the UI rule id in the title, takes the old wording verbatim unless a rebuild note or
a §4.10 gap says otherwise, and fixes its own a11y gaps (labels, roles, `aria-expanded`, focus on
inline confirms, Escape closes). Wording helpers (`describePush`, `describeDestState`,
`summarizeChanges`, …) stay in Vue; anything that decides rather than words lives in the core.

- [x] **M5.01 UI test footing.** The rule-coverage test also scans `apps/` for titles; a `mountView`
  helper (Pinia with real stores over a seeded fake, the activity store fed by an audit log); the
  fake gains realistic seed builders (catalogs, records with every install state, pins, accounts).
  - Rules: none (tooling)
  - Depends: M4.17
  - Done when: a UI rule id in an `apps/desktop` test title counts as covered (proved with a fixture
    plan, as M1.01 does); `mountView` renders a component against a seeded fake in one call.

- [x] **M5.02 View logic into the core (W-UI1).** Audit the old `desktop/src/catalog.ts`: each function
  that decides rather than words either maps to a facade result field already there or gains one:
  winner grouping (`allRows`/`winningRows`/`catalogRows`), install status, dependency and dependent
  views, `editableCatalogs` (rebuild: writable and not skipped; remote ones wait for M6),
  `requirableRefs`, `addConsequences`, `editableCopies`, `entryEdits`, `purgeable`, `installPlan`'s
  blocking (drift gate), `installedCopies`. Search ranking (UI-11) and hues (UI-14) stay in the UI.
  - Rules: none (behaviors.md §6 W-UI1; arch §2.5)
  - Depends: M5.01
  - Done when: a table in PROGRESS.md maps every old `catalog.ts` export to its new home; each moved
    rule has a core test; the facade contract test still passes.

- [x] **M5.03 Design tokens and primitives.** Port `assets/tokens.css` and its specs (no colour
  literals, 4.5:1 / 3:1 contrast in both themes), the button scale, `PageHeader`, `Busy`,
  `StatusBanner`, `Toasts`, `ActivityBar`, `AppearanceToggle` (native theme via `setTheme`).
  - Rules: UI-09, UI-50, UI-51, UI-52, UI-53, UI-54, UI-55
  - Depends: M5.01
  - Done when: each rule has a test; the old `tokens`, `contrast`, `buttons`, `theme`, `toasts`,
    `statusFeedback`, `pageChrome` and `AppearanceToggle` specs are ported.

- [x] **M5.04 App shell and view stack.** `App.vue` over the stores: launch (M4.05) then load,
  reload without pulling after writes, Refresh pulls; first-load Busy, dimmed reloads, freshness cue,
  error banner in place of the list; the view stack with its back trail, pruned after reloads;
  launch warnings shown once (per-catalog, A3). Replaces `DebugView.vue` and the M4 `main.ts` wiring.
  - Rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-08
  - Depends: M5.02, M5.03
  - Done when: each rule has a test; `App.spec.ts`'s surviving assertions are ported (browser-only
    mode dropped: the fake serves dev and tests, W-UI4).

- [x] **M5.05 Command log.** The bottom bar over the host's audit buffer (proc start/end) plus intent
  labels from the stores (W-UI2); never shows env values; Cancel aborts the running op.
  - Rules: UI-49
  - Depends: M5.04
  - Done when: UI-49 has a test; `CommandLog.spec.ts` and `commandActivity.spec.ts` are ported;
    cancelling an install from the bar aborts it (fake honouring the signal).

- [x] **M5.06 Catalog list.** Header with a labelled search, ranked search, rows and tabs, catalog
  hues, summary strip, counts, empty states, cards and install badges.
  - Rules: UI-10, UI-11, UI-12, UI-13, UI-14, UI-15, UI-16, UI-17, UI-18, UI-19
  - Depends: M5.04
  - Done when: each rule has a test; `EntryList.spec.ts` and `catalog.spec.ts`'s list and search
    cases are ported; "Hide overridden" no longer shows on the disabled tab (§4.10).

- [x] **M5.07 On/off switch.** `setSkillState` from the list for skills **and prompts** (Q15 A);
  `name-only`/`user-invocable-only` shown read-only (Q14 A); toasts as today.
  - Rules: UI-20
  - Depends: M5.06
  - Done when: UI-20 has a test; a prompt toggles; a read-only value shows and offers no switch.

- [x] **M5.08 Entry page.** `show` on open and on catalog change; the off note without "Parked at"
  (rebuild); source card; "On this machine"; copies and pins; requires and dependents.
  - Rules: UI-22, UI-23, UI-24, UI-25, UI-29, UI-31
  - Depends: M5.06
  - Done when: each rule has a test; `EntryDetail.spec.ts` and `InstalledCopies.spec.ts` are ported;
    dependency pills use one "installed" test (§4.10).

- [x] **M5.09 Uninstall and push from the entry page.** Two-step uninstall naming the override it
  removes (Q17 A); push with its provenance note and the PR or compare link. Success banners stay
  visible after the control unmounts (§4.10).
  - Rules: UI-26, UI-27
  - Depends: M5.08
  - Done when: each rule has a test; `UninstallControl.spec.ts` is ported.

- [x] **M5.10 Pin.** Two-step pin with the switch assessment, switching the installed copy when
  nothing needs a decision; unpin from the entry page.
  - Rules: UI-30
  - Depends: M5.08
  - Done when: UI-30 has a test; the `Pin` mistyping and the missing unpin status (§4.10) are gone.

- [x] **M5.11 Install.** The install page and preview: source picker when several catalogs hold the
  name; **file-level** preview with locally edited files flagged, destination-only when offline (Q5
  A, replacing UI-34's destination-level list); drift gate; button wording without the project
  scope; `STALE_PLAN` re-plans; unmanaged destinations reported (replacing them is M6).
  - Rules: UI-28, UI-32, UI-34, UI-35, UI-36
  - Depends: M5.08
  - Done when: each rule has a test; `InstallPreview.spec.ts`'s global-scope cases are ported; a
    destination-only preview renders when the fake's fetch fails.

- [x] **M5.12 Bulk install and remove.** Selection on a catalog tab, one preview for all ticked names,
  one drift gate, uninstall of the ticked installed ones.
  - Rules: UI-21, UI-37
  - Depends: M5.11
  - Done when: each rule has a test; `BulkInstall.spec.ts` is ported.

- [x] **M5.13 Sync and Doctor.** Sync plans on open and applies on confirm (A2: unmanaged reported,
  missing receipts listed); Doctor with the deep toggle disabled while running (§4.10) and the
  re-clone action for a diverged clone (A4).
  - Rules: UI-38, UI-39
  - Depends: M5.04
  - Done when: each rule has a test; `Sync.spec.ts` and `Doctor.spec.ts` are ported.

- [x] **M5.14 Catalogs and registration.** Registry level (add, health), pinned names, unregister
  with an in-flight guard (§4.10), a catalog's entries; register an existing catalog, create a new
  one, or add a shared one, with a picker that matches its hint (§4.10).
  - Rules: UI-41, UI-42, UI-43, UI-44, UI-45
  - Depends: M5.04
  - Done when: each rule has a test; `Catalogs.spec.ts` and `RegisterCatalog.spec.ts` are ported.

- [x] **M5.15 Authoring on local catalogs.** Add entry (with the source-URL suggestion, Q13 b),
  edit entry (only changed fields), remove entry (dry-run diff, dependents, purge), each through
  `planAdd`/`planUpdate`/`planRemove` and `applyCatalogEdit`; remote catalogs wait for M6.
  - Rules: UI-46, UI-47, UI-48
  - Depends: M5.14
  - Done when: each rule has a test; `AddEntry.spec.ts` and `EntryEditor.spec.ts` are ported;
    EntryRemove names a button that exists (§4.10).

- [x] **M5.16 Milestone check.** Every M5 rule in a test title; the old-spec port table complete in
  PROGRESS.md (ported or dropped, with reasons); `npm run check` green; a Finder-launched debug build
  walks list → entry → install → toggle → sync → doctor → catalogs → add/edit/remove on a local
  catalog (manual; the owner runs it).
  - Rules: none
  - Depends: M5.05, M5.07, M5.09, M5.10, M5.12, M5.13, M5.15
  - Done when: the rule-coverage test passes with every M1–M5 task checked and the manual walk is
    recorded in PROGRESS.md.

---

## M6. New surfaces

Exit: every M6 task checked; a teammate with nothing set up can go from first launch to a
connected account, an installed skill and a PR on the shared catalog without the Python CLI.

- [x] **M6.01 First run.** With no catalogs registered: import from the Python CLI (its `planImport`
  report shown first, `notImported` included) or add a catalog: paste a repo URL or create a
  personal one (Q12 A). Replaces the old FirstRun's bootstrap half (UI-06 rebuild).
  - Rules: none (open-questions.md Q12 A; arch §4.2)
  - Depends: M5.16
  - Done when: both paths land on a loaded list, tested against the fake.

- [x] **M6.02 Parked skills.** On the first launch that finds copies in `skills-disabled/`, list them,
  then move them back and turn them off (Q16 B); occupied destinations are reported.
  - Rules: none (arch §4.5 rule 7; Q16 B)
  - Depends: M6.01
  - Done when: the list, the migration and an occupied destination are tested.

- [x] **M6.03 Accounts page.** In the header beside Catalogs: per host, the account (login, scopes),
  Sign in (GitHub's code with a restart on `SIGN_IN_EXPIRED`; Bitbucket's redirect bringing the window
  forward and saying the tab can close), Check, Disconnect; the deep-link listener moves into a store.
  - Rules: none (arch §5.5; spikes.md S12)
  - Depends: M5.16
  - Done when: each state and outcome (connected, denied, expired, cancelled, unavailable) is tested.

- [ ] **M6.04 Authoring on shared catalogs.** Add, edit and remove on remote catalogs (UI-40
  rebuild): PR mode shows the PR or compare link; direct mode asks before pushing (Q3 A); a PR-mode
  write with no account offers "Connect {host} to open the PR here, or continue and get a link";
  `STALE_PLAN` re-plans.
  - Rules: none (open-questions.md Q3 A; behaviors.md §0.1)
  - Depends: M6.03, M5.15
  - Done when: PR (API and manual), direct (confirm and refusal) and the account offer are tested.

- [ ] **M6.05 Content Loadout didn't install.** Per item "Replace with the catalog's copy" that asks
  first, in the install preview, the entry page and doctor's unmanaged findings (Q8 A).
  - Rules: none (open-questions.md Q8 A)
  - Depends: M5.16
  - Done when: replace is offered only for unmanaged destinations and applies only after consent.

- [ ] **M6.06 Milestone check (manual).** On a fresh app-data folder, from a Finder-launched build:
  first run (add the shared catalog), sign in to Bitbucket and GitHub, install, toggle, and one PR
  on the shared catalog; record it in PROGRESS.md.
  - Rules: none
  - Depends: M6.01, M6.02, M6.03, M6.04, M6.05
  - Done when: every M6 task is checked and the run is recorded.

---

Potentially next (not planned yet): R, the first release to teammates (arch §7: CI build with the
OAuth clients as Actions secrets, Homebrew cask with the quarantine caveat, a manual smoke run of the
signed `.app` on a clean user account). Roadmap: infrastructure to record workflows in the native app
(Q13 c).
