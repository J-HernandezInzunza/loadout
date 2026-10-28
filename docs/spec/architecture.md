# The Library: architecture proposal for the native rebuild

Grounded in `behaviors.md` (same folder). Rule ids (`EDIT-08`, `W14`, …) refer to that document.
Library facts were checked against current docs (eemeli/yaml, Tauri v2 plugins, isomorphic-git via
Context7; Homebrew 5.0 release notes via the web) on 2026-10-14.

## 1. Summary

The new app is a macOS-only Tauri 2 application whose entire domain logic lives in a UI-free
TypeScript package (`@library/core`): catalog parsing and style-preserving splice writes, the
registry and pins, name and dependency resolution, git-backed fetching and update detection,
install/uninstall/sync with redesigned receipts and unmanaged-content detection, skill on/off through
Claude Code's own `skillOverrides` setting, catalog
authoring through the three write modes, and doctor. The core runs in the webview against a small
`Host` port implemented with Tauri's fs/shell/dialog/opener plugins, and against Node in tests. Vue 3
renders the core's results. Rust shrinks to plugin registration plus PATH widening. The app no longer
depends on Python, PyYAML, a bootstrapped venv, the `./library` wrapper, a clone of the tool repo, a
compile-time path baked into the binary, `LIBRARY_CWD` anchoring, or JSON parsing of CLI stdout. It
still depends on the system `git`, because nothing else supports the clone shapes the update
detection needs (§5). It no longer depends on `gh`: users connect their GitHub and Bitbucket
accounts in the app (browser sign-in), and Loadout passes those tokens to `git` and opens PRs
through the hosts' REST APIs (§5.5, decided 2026-10-28). Without a connected account, `git` still
uses whatever SSH keys or keychain credentials the user already has.

## 2. Module boundaries

### 2.1 Repository layout

```
packages/core/         @library/core: domain logic. No imports from vue or @tauri-apps/* (lint-enforced)
packages/host-node/    Host implemented with node:fs/promises + node:child_process (tests, future agent host)
apps/desktop/
  src/                 Vue 3 UI + host-tauri (Host implemented with Tauri plugins)
  src-tauri/           Rust: plugin registration, PATH widening, capabilities
tools/golden/          Dev-only Python harness that runs library.py functions to regenerate golden fixtures
```

Options for where the core executes, ranked:

1. **In the webview, behind a `Host` port (recommended).** No second runtime to ship or sign; the
   port keeps the core runnable under Node for tests and for the later agent iteration. Cost: CPU-heavy
   work (hashing, tree walks) must stay async and chunked so the UI thread never stalls (W16).
2. **Node sidecar process** (bundled Node, JSON-RPC over stdio). Gives full Node APIs and runs the
   future Agent SDK in-process, but re-creates the subprocess-and-JSON boundary this rebuild exists to
   remove, adds ~50 MB, and needs its own signing. Revisit only if the agent iteration requires it, and
   then only as a second `Host`.
3. **Domain operations as Rust commands.** Violates "Rust is minimal glue".

### 2.2 Host port (the only system boundary the core sees)

```ts
// packages/core/src/host.ts
export type FileKind = "file" | "dir" | "symlink";

export interface HostFs {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** temp file in the same directory + rename; never leaves a half-written file */
  writeTextAtomic(path: string, text: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ kind: FileKind; size: number; mode: number }>;   // follows links
  lstat(path: string): Promise<{ kind: FileKind; size: number; mode: number }>;
  readDir(path: string): Promise<{ name: string; kind: FileKind }[]>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;          // rejects { code: "EXDEV" } across volumes
  copyFile(from: string, to: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  makeTempDir(prefix: string): Promise<string>;             // under <appData>/tmp
}

export interface ProcResult { code: number; stdout: string; stderr: string; durationMs: number }
export interface HostProc {
  run(program: "git" | "gh", args: string[], opts: {
    cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal;
  }): Promise<ProcResult>;
}

export interface HostSecrets {                               // macOS Keychain in the app (§5.5)
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE"; url: string;
  headers?: Record<string, string>; body?: string; timeoutMs?: number; signal?: AbortSignal;
}
export interface HostHttp {                                   // host REST APIs and OAuth endpoints only
  request(req: HttpRequest): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface Host {
  fs: HostFs;
  proc: HostProc;
  secrets: HostSecrets;
  http: HostHttp;
  paths: { home: string; appData: string };
  now(): Date;
  sha256(data: Uint8Array): Promise<string>;                 // hex
  audit(event: AuditEvent): void;                            // process + destructive-fs log (W17)
}

export type AuditEvent =
  | { kind: "proc:start"; id: number; argv: string[]; cwd?: string }
  | { kind: "proc:end"; id: number; code: number; durationMs: number }
  | { kind: "fs"; op: "write" | "delete" | "move" | "copy-tree"; path: string; to?: string };
```

### 2.3 Core modules and public API

| Module | Owns (behaviors.md) | Public surface |
|---|---|---|
| `model` | §1 types | `Entry`, `EntryType`, `Catalog`, `Source`, `Receipt`, `InstallState`, `Result<T>` + zod schemas |
| `catalog/scalar` | EDIT-02, EDIT-03 | `pyyamlInline(value: string): string` (throws `MultilineValue`) |
| `catalog/splice` | §2.7 | `renderEntry(e): string[]`, `spliceEntry(text, e): string`, `removeEntry(text, type, name): string`, `replaceEntry(text, type, name, e): string` |
| `catalog/read` | §1.4, §1.12 | `parseCatalog(text): CatalogData` (YAML 1.1 semantics), `catalogEntries(data, catalogId): Entry[]` |
| `source` | §1.5, FETCH-01 | `parseSource(s): Source`, `cloneUrls(src): string[]`, `remoteWeb(url)`, `suggestSource(path)` |
| `config` | §1.12, MIG-* | `loadConfig()`, `saveConfig(cfg)`, `validateRegistry(raw): string[]`, `planImport(dir)`, `applyImport(plan)` |
| `registry` | §1.3, RES-* | `Registry` with `active()`, `writable()`, `entries()`, `entriesOf(id)`, `resolve(name, catalog?)`, `winners()`, `overrideSplit(entry)`, `candidates(query)` |
| `deps` | DEP-* | `resolveDeps(entries, target): { order: Entry[]; unresolved: Unresolved[] }`, `dependents(entries, target)`, `findCycles(entries)` |
| `git` | §5 of behaviors | `GitClient` (`clone`, `lsRemoteHead`, `probeOid`, `revParse`, `pullFfOnly`, `behindCount`, `commitAndPush`, `prBranch`), `CloneCache`, `ProbeCache` |
| `catalogs` | RCAT-* | `refreshCatalogs(policy)`, `ensureClone(cat)`, `catalogStatus(cat)` |
| `install` | INST-*, FETCH-* | `planInstall(req)`, `applyInstall(plan, opts)` |
| `receipts` | §4 below | `ReceiptStore` (`get`, `put`, `delete`, `all`) |
| `scan` | §1.11, SCAN-01, §4.4 below | `destState(dest)`, `scanInstallDirs(): InstalledItem[]` (managed / unmanaged / missing / parked by the Python CLI) |
| `claudeSettings` | §4.5 below | `readSkillOverrides()`, `setSkillState(names, "on" \| "off")`, `managedOverrides()` |
| `lifecycle` | UNIN-*, SYNC-* | `uninstall`, `planSync`, `applySync`, `migrateParked` |
| `write` | WRITE-* | `writeTarget(req)`, `applyCatalogEdit(cat, edit, mode)` (local / direct / pr), `openPullRequest` |
| `authoring` | add/update/remove/push/pin/unpin ops | `plan*` / `apply*` pairs |
| `doctor` | §2.10 | `doctor({ deep }): DoctorReport` |
| `ops` | §3 of behaviors | `createLibrary(host): Library` facade; every op has `input`/`output` zod schemas |

The facade, with plan/apply pairs for every mutation (W12) and decisions returned as results rather
than thrown or prompted (W8):

```ts
export interface Library {
  // reads (never touch the network unless asked)
  list(opts?: { catalog?: string; checkRemote?: boolean }): Promise<Result<EntryRecord[]>>;
  show(name: string, opts?: { catalog?: string }): Promise<Result<EntryDetail, NameErr>>;
  catalogs(): Promise<Result<CatalogRow[]>>;
  pins(): Promise<Result<PinRecord[]>>;
  scan(): Promise<Result<ScanReport>>;                        // managed + unmanaged + missing
  doctor(opts?: { deep?: boolean; signal?: AbortSignal }): Promise<Result<DoctorReport>>;
  refresh(opts?: { signal?: AbortSignal }): Promise<Result<RefreshReport>>;   // pulls clones

  // install lifecycle
  planInstall(req: { names: string[]; catalog?: string; signal?: AbortSignal }):
    Promise<Result<InstallPlan, NameErr>>;                     // fetches; file-level diff per dest
  applyInstall(plan: InstallPlan, opts: { overwrite: OverwriteConsent; signal?: AbortSignal;
    onProgress?: (p: Progress) => void }): Promise<Result<InstallReport>>;
  uninstall(req: { names: string[]; forcePaths?: string[] }): Promise<Result<UninstallReport, NameErr>>;
  setSkillState(names: string[], state: "on" | "off"): Promise<Result<ToggleReport, NameErr | SettingsErr>>;  // §4.5
  migrateParked(paths: string[]): Promise<Result<ToggleReport>>;   // copies the Python CLI parked in skills-disabled
  planSync(opts?: { force?: boolean; signal?: AbortSignal }): Promise<Result<SyncPlan>>;
  applySync(plan: SyncPlan, opts: { overwrite: OverwriteConsent; signal?: AbortSignal;
    onProgress?: (p: Progress) => void }): Promise<Result<SyncReport>>;

  // registry
  planAddCatalog(req: AddCatalogReq): Promise<Result<CatalogPlan>>;  // clones/reads to prove it works
  applyAddCatalog(plan: CatalogPlan): Promise<Result<CatalogRow>>;
  initCatalog(req: { path: string; id: string; position: "first" | "last" }): Promise<Result<CatalogRow>>;
  removeCatalog(req: { id: string; purgeClone: boolean; purgeInstalls: boolean }): Promise<Result<UnregisterReport>>;

  // authoring
  planAdd(req: AddReq): Promise<Result<CatalogEditPlan, WriteErr>>;
  planUpdate(req: UpdateReq): Promise<Result<CatalogEditPlan, WriteErr>>;
  planRemove(req: RemoveReq): Promise<Result<CatalogEditPlan, WriteErr>>;
  applyCatalogEdit(plan: CatalogEditPlan, opts?: { signal?: AbortSignal }): Promise<Result<WriteResult>>;
  planPush(req: { name: string; catalog?: string }): Promise<Result<PushPlan, WriteErr>>;
  applyPush(plan: PushPlan, opts?: { message?: string }): Promise<Result<PushResult>>;
  planPin(req: { name: string; catalog: string }): Promise<Result<PinPlan, NameErr>>;
  applyPin(plan: PinPlan, opts: { switchInstalled: boolean }): Promise<Result<PinResult>>;
  unpin(name: string): Promise<Result<UnpinResult>>;

  // one-time import
  planImport(toolDir?: string): Promise<Result<ImportPlan>>;
  applyImport(plan: ImportPlan): Promise<Result<ImportReport>>;
}

export type Result<T, E extends CoreError = CoreError> =
  | { ok: true; value: T; warnings: Warning[] }
  | { ok: false; error: E; warnings: Warning[] };

export type NameErr = CoreError & { code: "NOT_FOUND" | "AMBIGUOUS_NAME"; candidates: Candidate[] };
export type WriteErr = CoreError & { code: "AMBIGUOUS_CATALOG" | "READ_ONLY" | "LOCAL_SOURCE_REFUSED"
  | "SOURCE_IN_INSTALL_DIR" | "DUPLICATE" | "SPLICE_UNSUPPORTED" | "MULTILINE_VALUE" | "NO_WRITABLE_CATALOG";
  catalogs?: string[] };
```

Every plan carries a fingerprint of what it was computed against (catalog file sha for edits, source
commit + destination hashes for installs). `apply*` re-checks it and returns `STALE_PLAN` instead of
writing over a world that moved, which is the TS form of WRITE-15's "compute the edit against the
same bytes you write".

### 2.4 Rust layer

Rust contains no domain logic and, in the recommended shape, **no `#[tauri::command]`** except the three
Keychain commands behind `HostSecrets` (§5.5):

- `main.rs`/`lib.rs`: repair the environment before the builder starts (`src/path.rs`, ported from
  `desktop/src-tauri/src/path.rs`: login-shell probe with a 10 s timeout, the shell's PATH **first**,
  `CLAUDE_CONFIG_DIR` adopted; spikes.md S2), then register plugins. ~60 lines.
- Plugins:

| Plugin | Why | Capability |
|---|---|---|
| `tauri-plugin-fs` | every read/write/move the core does | `fs:default` + scoped allow lists below |
| `tauri-plugin-shell` | spawn `git` | `shell:allow-spawn`, `shell:allow-execute`, `shell:allow-kill` with scope `[{name:"git", cmd:"git", args:true}]` (`gh` dropped, §5.5) |
| `tauri-plugin-http` | host REST APIs and OAuth token endpoints (§5.5) | `http:default` scoped to `https://api.github.com/*`, `https://github.com/login/*`, `https://api.bitbucket.org/*`, `https://bitbucket.org/site/oauth2/*` |
| `tauri-plugin-deep-link` | receive the OAuth redirect (`loadout://oauth/…`) in M4, if the hosts accept a custom scheme; else a loopback listener (§5.5) | — |
| `tauri-plugin-dialog` | pick catalog dirs, source files, import folder | `dialog:allow-open` |
| `tauri-plugin-opener` | open PR/compare URLs, reveal in Finder | `opener:default` |
| `tauri-plugin-single-instance` | one process mutating receipts and clones at a time (replaces the CLI's cross-process `flock`, LOCK-01) | — |
| `tauri-plugin-updater` | later, after notarization (§7) | — |

FS scope options, ranked:

1. **`$HOME/**` read/write with explicit denies** (`$HOME/.ssh/**`, `$HOME/Library/Keychains/**`,
   `$HOME/.gnupg/**`, and, decided with the dot-directory change, `$HOME/.config/gh/**`,
   `$HOME/.aws/**`, `$HOME/.netrc`, `$HOME/.docker/**`, `$HOME/.kube/**`) plus `$APPDATA` and `$APPDATA/**` (recommended). Requires
   `plugins.fs.requireLiteralLeadingDot: false`: by default `**` skips dot-components, which excluded
   `~/.claude` and dotfiles inside skills; and `$APPDATA/**` alone does not cover the folder itself
   (spikes.md S3a). Local catalogs and local sources can live
   anywhere under home, and a local-source push writes there (FETCH-07, push). The webview loads only
   bundled code with a strict CSP (today `security.csp` is `null`, `desktop/src-tauri/tauri.conf.json`),
   so the scope is defence in depth, not the trust boundary.
2. Narrow static scope (`~/.claude/**`, `$APPDATA/**`) plus runtime `allow_directory` for each
   registered local catalog and source. Tighter, but needs a Rust command and persisted scopes, and
   every new local path becomes a failure mode.
3. Unscoped `fs:allow-*`. No.

Shell args stay `true` (unvalidated) for `git`: the arguments are URLs, paths and refs that no
regex validates usefully, and the core never passes user text through a shell (argv only).

### 2.5 Vue layer

- Pinia stores per area (`catalogStore`, `installStore`, `registryStore`, `activityStore`) hold the
  last core results; components never call the host or plugins directly. Ranked against today's
  module-level reactive objects: Pinia wins on devtools and `createTestingPinia`, at little cost.
- The domain logic in today's `desktop/src/catalog.ts` that is not presentation (row grouping by
  winner, `installPlan` blocking rules, `addConsequences`, `entryEdits`, `purgeable`,
  `editableCatalogs`) moves into the core; wording functions (`describePush`, `describeDestState`,
  `summarizeChanges`) stay in the UI.
- Long-running ops: the store passes an `AbortController.signal` and an `onProgress` callback; the
  activity bar and command log subscribe to `Host.audit` events (W17). Cancel aborts between items and
  kills the running `git` child (`Child.kill()` from the shell plugin).
- Refresh policy is explicit: pull on launch, on Refresh, and inside writes; every other read uses the
  clones on disk (closes W14's gap where every app command pulled).

## 3. Catalog compatibility strategy

### 3.1 Options

1. **Hand-port the line-based splice functions and PyYAML's one-line scalar emitter (recommended).**
   `_locate_section`, `_item_starts`, `splice_entry`, `remove_entry`, `replace_entry`, `render_entry`
   are ~120 lines of regex and list slicing (`library.py:2673-2826`) that port almost line for line.
   `_yaml_inline` needs PyYAML's YAML 1.1 implicit resolvers (bool/null/int/float/timestamp/merge/
   value regexes) plus `Emitter.analyze_scalar`/`choose_scalar_style` and the single/double-quoted
   writers for one-line output: ~200 lines, verified by a differential corpus (§3.2). This is the only
   option that reproduces EDIT-09 to EDIT-12 byte for byte, including the quirks.
2. **eemeli/yaml CST (`Parser` + `CST.visit` + `CST.stringify`).** Lossless for untouched tokens, so
   it would preserve everything outside an edit. But its item boundaries are token-based: comments
   and blank lines attach to neighbouring items differently from the CLI's line ranges, so EDIT-10
   (blank separator removed with the last item), EDIT-11 (comment ownership) and EDIT-12 would all need
   compensating code, and it cannot represent the invalid intermediate texts the CLI produces and then
   rejects (EDIT-09). It still needs a PyYAML-compatible scalar writer. More code, less fidelity.
3. **eemeli/yaml `Document` API (`parseDocument` → mutate → `toString()`).** Re-stringifies the whole
   file: indentation, quoting and blank-line placement are re-derived, so untouched entries change.
   Breaks the contract outright.

Reading catalogs uses `yaml.parse(text, { version: "1.1" })` so `yes`, `on`, sexagesimal ints and
timestamps resolve the way PyYAML does, then validates field types (the CLI does not; a non-string
name crashes it, §7). WRITE-16's verification re-parses with the same function.

Quirks (decided 2026-10-28: **fix**, Q4 C, A12, A13; exact rules in behaviors.md §0.1 D1–D4): missing
sections are created (D1); layouts the splice can't edit, including `[ ]` and 2-space items, are refused
up front with `SPLICE_UNSUPPORTED` (D2); remove keeps the blank lines and comments around the item (D3);
update edits fields in place and keeps unknown keys, comments and blank lines (D4). The port still starts
from the line-based functions, and every golden case is still generated from `library.py`; cases where
the rebuild deviates carry a hand-written `rebuild` expectation alongside the recorded Python output.
The Python suite pins the old behavior as "current behavior" (`tests/test_library.py:835`, `913`, `981`,
`1015`, `1057`); those become the deviation cases.

### 3.2 Golden-file test plan

1. `tools/golden/gen.py` (dev-only, runs with the old repo's `.venv/bin/python`, imports `library.py`
   read-only with `PYTHONDONTWRITEBYTECODE=1`) emits JSON fixtures into the new repo:
   - **splice corpus:** the Python suite's whole-file splice goldens (`tests/test_library.py:549-1073`,
     plus the write-seam cases at `8540`, `8693`, `9150`), `library.example.yaml`, and the
     EDIT-09/10/11/12 edge texts in behaviors.md Appendix D; for each,
     a scripted list of operations (insert at start/middle/end, into `[]`, duplicate, remove
     first/middle/last/only, replace first/last, batch add) with the exact output text or the exact
     `LibraryError` message.
   - **scalar corpus:** ~200 hand-picked strings (every YAML 1.1 indicator, resolver look-alike, leading
     and trailing spaces, quotes, tabs, non-ASCII, URLs) plus a seeded generator of ~5,000 random
     printable strings, each mapped to `_yaml_inline`'s output or "multiline".
   - **source corpus:** `parse_source` outputs for every URL shape in §1.5 and the failure forms.
   - **hash corpus:** small trees (nested dirs, empty files, unicode names) with `content_hash`
     outputs, so the importer can classify Python-CLI installs (§4.4). The Python suite never pins a
     digest value (`tests/test_library.py:3711-3752` only compares hashes to each other), so this
     corpus is new and is the only cross-language check of the algorithm.
   - **registry corpus:** `Config.problems` outputs for valid and invalid configs (drives import
     validation).
2. Fixtures are committed; the core's Vitest suite replays them and asserts byte equality (text) or
   deep equality (JSON). CI never needs Python.
3. A manual `just golden-diff` recipe re-runs the generator against a newer `library.py` and diffs, so
   a Python-side change is noticed rather than silently diverging.
4. Before release, run the new core's `add`/`update`/`remove` against a copy of each real team catalog
   alongside `library.py --dry-run --json` (local-mode dry runs return the unified diff,
   `library.py:3092-3098`) and require identical diffs.

## 4. Config and receipts

### 4.1 On-disk layout

Under the Tauri app data dir (`~/Library/Application Support/com.jhernandezinzunza.loadout/`):

```
config.json          registry, pins, settings (schema below)
receipts.json        install receipts, version 2
clones/<catalog id>/ persistent clones of remote catalogs (RCAT-01 without the 'shared' special case)
tmp/<op id>/         per-operation temp clones and staging; swept at launch (fixes FETCH-09's leak)
```

`config.json`:

```ts
interface AppConfigV1 {
  version: 1;
  catalogs: Array<
    | { id: string; kind: "local"; path: string; writable?: boolean }
    | { id: string; kind: "remote"; repo: string; yamlPath: string; branch: string;
        protected: boolean; writable?: boolean }>;
  pins: Record<string, string>;
  settings: Record<string, never>;   // reserved; autopush, default_add_catalog, default_dirs dropped (Q10, Q11)
  imported?: { from: string; at: string; configSha256: string };
}
```

JSON over YAML: the app owns the file, nobody hand-edits it, and JSON avoids YAML 1.1 ambiguity.
`protected` is stored explicitly (the CLI's "absent means true" default, `library.py:733`, versus
`catalog add` writing `false`, `library.py:5928-5931`, is a trap worth not carrying). Appearance stays
in `localStorage` (UI preference, not domain state).

### 4.2 One-time import from `config.local.yaml`

1. Locate the Python tool dir: resolve `~/.claude/skills/library` (the symlink `library link`
   creates, `library.py:5694-5728`); otherwise ask the user to pick the folder.
2. Parse `config.local.yaml` with YAML 1.1 semantics; validate with the port of `Config.problems`
   (golden-tested); refuse to import an invalid file and show the problems.
3. Normalize: legacy `catalog:` → one remote `shared` catalog, `protected: true` (MIG-01).
4. Map: catalogs in order (defaults made explicit, `writable` kept), and pins. Report, without
   importing: `autopush`, `default_add_catalog`, `default_dirs` and `git_commit` (dropped, Q10/Q11),
   unknown top-level keys, quoted booleans the CLI coerced with `bool()` (A22, read strictly).
5. Show the plan, write `config.json` on confirmation, record `imported`. Never modify the old file.
   Clones are not copied; the first refresh re-clones into `clones/`.
6. Receipts are **not** imported (the decision: Python-installed content is unmanaged). The importer
   remembers `<tool dir>/.installs.json` only as a classification hint (§4.4).

### 4.3 Receipts v2

```ts
interface ReceiptsFileV2 { version: 2; installs: ReceiptV2[] }      // sorted by dest
interface ReceiptV2 {
  dest: string;                         // absolute path; one receipt per destination (as today)
  type: "skill" | "agent" | "prompt";
  name: string;
  catalog: { id: string; key: string }; // key = identity (§1.2 catalog_key)
  source: string;                       // verbatim catalog source string
  commit: string | null;                // source repo HEAD at install (null for local sources)
  sourceOid: string | null;             // tree/blob oid of what was copied (UPD-02/03)
  files: Record<string, string>;        // posix relpath -> sha256; replaces content_hash
  installedAt: string;                  // ISO-8601 UTC
}
```

Options for what a receipt records about content, ranked: (1) **per-file hash manifest
(recommended)**: it enables a real file-level preview ("you edited `SKILL.md`; upstream changed
`references/x.md`") and per-file drift, at a few hundred bytes per install; (2) one aggregate hash, as
today: cheaper, but drift is all-or-nothing and the preview cannot say which edits would be lost;
(3) no hash, compare against the source on demand: it needs the network to answer "did I edit this?".

Changes from v1, each with its reason: `files` replaces `content_hash` because per-file hashes give
per-file local-edit detection in the install preview (the MVP's "file-level preview"); `scope`
disappears (global only); `catalog` and `catalog_key` merge into one object. Kept from v1: `dest` as
key, `commit`, `sourceOid`, derived (never stored) state, and "a receipt is provenance, the disk is
state" (`library.py:1916-1923`). Writes go through `writeTextAtomic` behind an in-process queue
(single-instance plugin covers other processes), closing LOCK-02's lost-update race.

### 4.4 Unmanaged-content detection

Run on `scan()` and before every install, sync, uninstall and toggle:

1. For each install dir (`~/.claude/skills`, `~/.claude/agents`, `~/.claude/commands`, or the
   configured overrides), list top-level items: directories in the skills dir, `*.md` files in the
   others. Skip dot-prefixed names and `synced` (any case), as SCAN-01 does; record symlinks (e.g. the
   Python tool's own `library` link) without following them. Also list `<dir>-disabled/` (e.g.
   `~/.claude/skills-disabled/`), only to find copies the Python CLI parked there (§4.5).
2. For each item: receipt for that path? → **managed**: compare `files` with the disk → `installed`
   or `drifted` (with the list of edited, added and deleted files). Whether it is on or off comes from
   Claude Code's settings, not the disk (§4.5).
3. No receipt → **unmanaged**, with an informational origin:
   - `python-cli`: the remembered `.installs.json` has a receipt for this dest and the CLI's
     `content_hash` algorithm (`library.py:191-211`, golden-tested) matches it;
   - `python-cli-edited`: such a receipt exists but the hash differs;
   - `parked-by-python-cli`: the item sits in a `-disabled` folder;
   - `symlink`: the item is a symlink (reported, never followed or touched);
   - `foreign`: anything else (hand-copied, another tool).
   Each unmanaged item also notes whether a catalog entry of that name and type exists.
4. Receipts whose dest is gone → **missing** (reported, never acted on, SYNC-06).
5. Policy: the core never overwrites, moves or deletes an unmanaged item unless the request names that
   exact path in `overwrite.unmanaged` / `forcePaths`. Sync skips unmanaged items and reports them
   (deliberately unlike SYNC-03). Installing over one with consent is "adopt": the result is a managed
   install with a receipt.

Scan depth, ranked: (1) **top level only (recommended)**, because that is where installs land
(`library.py:2284-2288`) and what Claude Code loads as skills, so "unmanaged" means something the
user can see; (2) recursive like the CLI's `holds_copy` (`library.py:1832-1855`), which counts a
same-named directory nested anywhere as "installed"; useful only for the `--dir` installs v1 drops,
and it is the source of the `installed` vs `state` disagreement (RES-07, §7 of behaviors.md).
`commands/` subdirectories (namespaced prompts) are listed as unmanaged directories, not descended.

### 4.5 Turning skills on and off (decided 2026-10-28)

**Decision.** Toggling uses Claude Code's own setting instead of moving folders. Turning a skill off
writes `"<skill name>": "off"` under `skillOverrides` in `~/.claude/settings.json` (user scope: every
project on this machine); turning it back on deletes that key, because a skill missing from
`skillOverrides` is treated as `"on"`. Files never move. This replaces the CLI's archive mechanism
(§1.10 and the DIS rules in behaviors.md, now tagged `drop`).

What Anthropic documents (checked 2026-10-28):

- Values: `"on"`, `"name-only"` (Claude sees the name only), `"user-invocable-only"` (hidden from
  Claude, still typeable), `"off"` (hidden from Claude and from `/` autocomplete; invoking it by
  name returns a `skillOverrides` error). Any settings file may hold the key; the `/skills` menu writes
  it to the **project-local** `.claude/settings.local.json`.
- Keys are skill names. The docs say a skill's name is its `SKILL.md` frontmatter `name` when set,
  otherwise its directory name. **Measured (spikes.md S10, Claude Code 2.1.312): overrides match the
  directory name; a differing frontmatter `name` is ignored for this.** In user, project and local
  settings, entries match skill names only (no aliases).
- Plugin skills are not affected.
- Custom commands in `.claude/commands/` "still work and are merged into skills", so a prompt
  installed as `~/.claude/commands/<name>.md` is toggleable the same way (verified, spikes.md S9). Decided:
  v1 toggles skills and prompts, agents later (Q15 A); the UI offers on/off only and shows
  `name-only`/`user-invocable-only` read-only when set elsewhere (Q14 A).
- Agents are not covered. The documented way to stop Claude using a subagent is
  `permissions.deny: ["Agent(<frontmatter name>)"]`, which blocks it rather than hiding it, and
  `permissions` lists merge across files, so a user-level deny can't be undone per project.
- Claude Code watches settings files and reloads most keys without a restart; `skillOverrides` is
  not in the documented list of keys read only at session start. Verified (spikes.md S8): an open
  session refuses a skill turned off after it started.

Design rules:

1. **Name the right key: the entry name.** Overrides match a skill's directory name (spikes.md S10),
   and Loadout installs every skill to `~/.claude/skills/<entry name>/`, so the key is always the
   catalog entry name; a prompt's key is its file name without `.md`, also the entry name. A
   frontmatter `name` is never used as the key. Re-check this on Claude Code upgrades.
2. **Edit `settings.json` without damaging it.** It is strict JSON, owned by you and written by
   Claude Code itself (`/config`, `/model`). Parse first; if it doesn't parse, refuse and say so,
   never overwrite. Apply a minimal text edit (`jsonc-parser`'s `modify` + `applyEdits` keeps your
   formatting, key order and `$schema`). Re-read and compare just before writing and retry once if
   Claude Code wrote in between; write via temp file + rename in the **real** file's directory, so a
   symlinked (dotfile-managed) `settings.json` stays a symlink; keep the file mode. Create the file
   with `{"skillOverrides": {...}}` only if it doesn't exist.
3. **Respect `CLAUDE_CONFIG_DIR`.** When set, Claude Code keeps its settings there instead of
   `~/.claude`. A Finder-launched app doesn't see shell exports, so the startup login-shell probe
   (§5.3) captures this variable along with `PATH`.
4. **Report what the app can't control.** Managed settings and each project's `.claude/settings.json`
   / `.local.json` sit above user settings. Doctor reads the managed settings file and warns when it
   sets an override for a catalog skill. Project and local `skillOverrides` **merge per key** with the
   user's (spikes.md S7): a global toggle keeps applying in every project, except where that project
   sets the same skill to another value (the `/skills` menu writes such values to
   `.claude/settings.local.json`). Doctor can't see every project, so the UI copy says "on this
   machine, unless a project overrides it".
5. **One name, every copy.** A user-level override applies to every skill with that name in every
   project, not just the installed copy. Personal skills already shadow project skills of the same
   name, so this rarely changes anything, but the UI copy should say "turned off on this machine".
6. **Toggles are independent of installs.** An off skill updates in place on install and sync and
   stays off; its dependencies install normally; uninstall removes the files and deletes the
   override, saying so in the confirmation (Q17 A). The UI may toggle unmanaged skills too, since the setting doesn't
   care who installed the files.
7. **Migrate what the Python CLI parked** (Q16 B). On first launch, the app lists every copy in
   `~/.claude/skills-disabled/<name>` and, after the user has seen the list, moves each back to
   `~/.claude/skills/<name>` (EXDEV-safe copy-verify-delete, DIS-03) and writes the override. A copy
   whose destination is occupied is left in place and reported. The app never writes into `-disabled` folders.
   The Python CLI keeps working on the same machine but sees app-disabled skills as installed.

What this removes from the CLI design: the archive folders, `move_tree` for toggles, the "copy in
both places" refusal and doctor error, refreshing disabled entries inside the archive (INST-06,
DEP-07, SYNC-07, gap A1), doctor's archive sweep (check 34), and the receipt-indirection `enable`
needed to find where a copy came from (DIS-04).

Core API: `readSkillOverrides(): Promise<Map<string, OverrideValue>>`,
`setSkillState(names: string[], state: "on" | "off"): Promise<Result<ToggleReport, NameErr | SettingsErr>>`
in a new `claudeSettings` module; `SettingsErr` covers an unparseable or unwritable file.

Tests: golden cases for the JSON edit (formatting preserved byte-for-byte outside the changed key;
missing file; empty object; invalid JSON refused; symlink preserved; concurrent change detected).

## 5. Git and network

### 5.1 Library choice

| Need (behaviors.md §5) | system `git`/`gh` via shell plugin | isomorphic-git | gitoxide (Rust) | libgit2 (Rust) |
|---|---|---|---|---|
| SSH remotes with the user's keys/agent/`~/.ssh/config` | yes | **no SSH transport** (HTTP plugins only) | via `ssh` binary | libssh2: no `~/.ssh/config` |
| HTTPS with credential helpers (osxkeychain, `gh auth git-credential`) | yes | only via `onAuth` callback | partial | callback |
| `--depth 1` clones | yes | yes | yes | limited |
| `--filter=blob:none --no-checkout` probe (UPD-02) | yes | **no filter option** in `fetch` | partial | no |
| `ls-remote` | yes | `getRemoteInfo` (HTTP only) | yes | yes |
| `rev-parse <commit>:<path>` tree oid | yes | `readTree`/`resolveRef` | yes | yes |
| push, PR creation | `git push`; PRs through the host REST APIs (§5.5) | push only | push only | push only |
| Rust code required | none | none | substantial | substantial |

Ranking: **(1) system git (recommended)**, with tokens from connected accounts (§5.5) or the user's
existing SSH/keychain credentials, every needed operation exists, zero Rust; (2) gitoxide, which would need Rust commands and
still shells out to `ssh`; (3) libgit2; (4) isomorphic-git, where no SSH and no partial clone rules it out.

Alternatives to cloning for source fetching: GitHub/Bitbucket REST or raw downloads would need API
tokens that SSH-only users do not have, and Bitbucket raw URLs need app passwords. Same correctness,
worse auth. Rejected.

### 5.2 What to keep, what to change

Keep as-is (all `free`, all proven): ssh-then-https ordering and non-interactive env
(`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/true`, `GIT_SSH_COMMAND` defaulting to
`ssh -oBatchMode=yes`) (FETCH-02/03); per-operation clone cache keyed by repo+branch (FETCH-04);
`ls-remote` memo + blobless probe + oid comparison + receipt commit advance (UPD-01..05); persistent
shallow catalog clones with `pull --ff-only`; PR flow (temp clone, branch, commit, push)
(WRITE-07..10). Changed: no `autopush` and no `gh`. After the push, Loadout opens the PR through the
host's REST API when an account for that host is connected (GitHub and Bitbucket alike), and
otherwise returns the compare URL; an API failure is a warning with the compare URL, and "a PR for
this branch already exists" is success with that PR's URL (§5.5, WRITE-11, Q2).

Change (same round trips, more correct or more predictable):

- `git ls-remote <url> refs/heads/<branch>` instead of the bare branch pattern, which also matches
  `refs/heads/feature/<branch>` and tags and takes the first line (§7).
- Timeouts on every network command (none today outside doctor, behaviors.md §7.2 G9) and
  cancellation through `AbortSignal`.
- Reads never pull implicitly; pulls happen on launch, Refresh, and inside writes (W14).
- A remote catalog that fails to **clone** is skipped with a reason instead of aborting every
  command (RCAT-05).
- A diverged persistent clone is reported by doctor with a "re-clone" action instead of failing
  ff-only forever (RCAT-10).
- The file-level install preview fetches during `planInstall` (into the per-op clone cache) and
  `applyInstall` copies from that same checkout; if the plan was discarded, apply re-clones and returns
  `STALE_PLAN` if the head moved. The preview therefore needs the network, unlike today's dry run
  (INST-05) (open question 5).
- Installs stage into `tmp/` and `rename` into place, so an interrupted install never leaves a
  half-copied skill (today `rmtree` then `copytree`, FETCH-06).

### 5.3 PATH in a Finder-launched bundle

A bundle launched from Finder or Dock gets launchd's `/usr/bin:/bin:/usr/sbin:/sbin`. `/usr/bin/git`
exists but is the Xcode Command Line Tools shim (it opens an install dialog when the tools are
missing); Homebrew `git` and `gh` are not on that PATH (`desktop/src-tauri/src/path.rs:1-12`).
Options, ranked: (1) keep today's widening in Rust `main` before plugins start: login-shell probe
plus fallbacks (W3), ~40 lines; the same probe also captures `CLAUDE_CONFIG_DIR` (§4.5). Two changes
from the old app, both from spikes.md S2: the shell's PATH goes **first** (appending left launchd's
`/usr/bin/git`, the Xcode shim, ahead of Homebrew's git), and the probe gets a 10 s timeout (heavy but
ordinary profiles take 2–3 s; the old code had none). Decided for M4: cache the probed PATH in app
data, use it at once on launch, and refresh it in the background for the next launch; (2) resolve absolute program paths at startup and
put them in shell-plugin scopes, but the static capability file cannot know them; (3) let users configure
paths, a setting that only matters when (1) fails. Doctor gains a check: `git --version` runs, `xcode-
select -p` succeeds, and, for each host with a protected catalog, that an account is connected and its
token still works (§5.5).

### 5.4 Offline behaviour

Reads work from clones on disk with a freshness timestamp; refresh failures become warnings per
catalog with the reason; `planInstall`/`sync` mark items `unreachable` rather than failing the batch;
staleness shows "couldn't check" rather than "up to date" when `ls-remote` fails.

### 5.5 Accounts (decided 2026-10-28)

Users connect a GitHub and/or Bitbucket account from an Accounts screen with a browser sign-in
(OAuth). There is no token-paste field. Options considered, ranked: (1) browser sign-in (chosen);
(2) paste a personal token in Settings, same plumbing, less polish; (3) keep relying on the user's
`gh` and git setup with guided onboarding.

- **Tokens** live in the macOS Keychain through `Host.secrets` (service `com.jhernandezinzunza.loadout`,
  account `<host>`). Non-secret account facts (login, scopes, connected-at) live in `config.json`
  under `accounts`. Disconnect deletes both.
- **git** gets the token per command, never on disk: for an https URL on a connected host, the core
  runs `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get && printf
  "username=%s\npassword=%s\n" "$LOADOUT_GIT_USER" "$LOADOUT_GIT_TOKEN"; }; f' …` with the two
  variables in that child's environment only. Usernames: `x-token-auth` for Bitbucket OAuth tokens
  (Atlassian docs); for GitHub, verify in M2 (`x-access-token` is the usual choice). The token never
  appears in argv, in a remote URL (which git would save to `.git/config`), or in `Host.audit`.
  Clone order (FETCH-02, rebuild): a connected host is tried over https first; otherwise ssh then
  https, as before.
- **PRs** go through the REST APIs: GitHub `POST /repos/{owner}/{repo}/pulls`; Bitbucket
  `POST /2.0/repositories/{workspace}/{repo}/pullrequests`. A duplicate is resolved to the existing
  PR (GitHub's 422 "already exists", Bitbucket's equivalent; exact shapes verified against the real
  APIs before release). No connected account → the compare URL, as today's manual mode.
- **OAuth flows (M4).** GitHub: an OAuth app (or GitHub App) with device flow or browser redirect;
  device flow needs no client secret. Bitbucket Cloud: an OAuth consumer registered in a workspace;
  its token exchange requires the consumer secret and Atlassian documents no PKCE. The user still
  signs in and grants access in the browser; the secret only identifies the app. It is never
  committed (the repo is public): it is a GitHub Actions secret that the release build injects, so
  it ends up inside the built app, where it can be extracted (§10 risk 13). Bitbucket access
  tokens last two hours; the core refreshes them with the refresh token before git or API calls.
  Redirect: a custom scheme through `tauri-plugin-deep-link` if both hosts accept it as a callback,
  otherwise a one-shot loopback listener; verify in the M4 spike.
- **Rust.** No official Tauri plugin reaches the Keychain, so the Rust layer gains three commands
  (`secret_get`, `secret_set`, `secret_delete`, via the `keyring` crate) behind which
  `host-tauri`'s `HostSecrets` sits. This is the one exception to §2.4's "no commands".
- **Without an account,** everything still works with the user's existing SSH keys or keychain
  credentials (spikes.md S1); PRs are then a compare link, and doctor says how to connect.

## 6. Testing

- **Gate** (`npm run check`, target < 60 s, hermetic): typecheck, ESLint with an import-boundary rule
  (core may not import `vue` or `@tauri-apps/*`), Vitest for core and UI, `cargo check`. No network,
  no Python, no real `~/.claude`.
- **Core tests on the Node host** with a per-test temp `HOME` and app-data dir (the Python suite's
  `TempTool` sandbox, which fails if any path escapes it, `tests/test_library.py:49-161`, is the
  model). Options for git, ranked: (1) **real git against local bare repos (recommended)**, with a
  test-only global git config (`GIT_CONFIG_GLOBAL`) holding `url."file://<tmp>/remotes/".insteadOf`
  rules for `git@github.com:`, `https://github.com/` and the Bitbucket forms, so production URL shapes
  resolve locally; remotes must be **`file://` URLs, not plain paths**, because git ignores `--depth`
  and `--filter` for plain-path clones (which is why the Python suite never exercised shallow or
  blobless clones, behaviors.md §5.4 and `tests/test_library.py:543-546`); mapping only the https form
  exercises the ssh→https fallback; `GIT_ALLOW_PROTOCOL=file` makes any leak to the network fail
  (one Python test leaks, `tests/test_library.py:4145-4150`); (2) a fake `HostProc` replaying recorded
  git transcripts: fast, but tests the transcript, not git; (3) mocking `git` per call: brittle and
  blind to argv mistakes. The host APIs are a local HTTP stub (GitHub and Bitbucket endpoints for
  user, token refresh and PR create/list) that records requests and returns canned responses; the
  core's API base URLs are injectable for tests only. git's token injection is tested against a
  `file://` remote by checking the credential helper's output, not a real host.
- **Golden data** (§3.2) for everything tagged `contract`.
- **Ported Python cases:** see the test-port table in behaviors.md Appendix D (from
  `tests/test_library.py`), prioritising splice, resolution, dependency, receipt-state, update
  detection, write-mode and doctor-check tests.
- **UI tests** (Vitest + Vue Test Utils) run against an in-memory `Library` fake implementing the same
  interface, not against IPC mocks; the existing specs' assertions (badges, banners, two-step
  confirmations, toasts, contrast and token guards) port almost unchanged.
- **Tauri boundary:** the host-tauri adapter is tested with `@tauri-apps/api/mocks` (`mockIPC`)
  asserting the plugin calls it makes; a test parses `capabilities/*.json` and fails if the shell scope
  allows anything but `git`/`gh` or the fs scope loses its denies; `cargo test` covers PATH widening;
  a release checklist covers one manual smoke run of the signed `.app` on a clean user account
  (WKWebView has no WebDriver, so there is no automated end-to-end on macOS).

## 7. Distribution

- **CI** (GitHub Actions, `macos-latest`): on tag `v*`, run the gate, then `tauri-apps/tauri-action`
  building `aarch64-apple-darwin` (Apple Silicon only, F6), ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), producing a
  `.dmg` and a zipped `.app`, attached to a GitHub Release with SHA-256 sums.
- **Homebrew cask** in a personal tap (`<user>/homebrew-tap`, `Casks/loadout.rb`): `url` to the
  release asset, `sha256`, `app "Loadout.app"`, `depends_on macos: ">= :sonoma"`, `depends_on arch: :arm64`
  (`minimumSystemVersion` 14.0, R18). A release job bumps `version`/`sha256` in the tap.
- **Quarantine (top risk, §10.1):** Homebrew 5.0 deprecated `--no-quarantine` and code-unsigned casks
  ("Homebrew does not wish to easily provide circumvention to macOS security features"), and later
  releases removed the flag; disabling of Gatekeeper-failing casks was announced for the official
  `homebrew/cask` tap in September 2026. A personal tap still installs, but the downloaded app carries
  `com.apple.quarantine`, and an ad-hoc signature does not pass Gatekeeper, so first launch is blocked.
  Decided for v1 (Q2 B): option 1. Interim options, ranked: (1) cask `caveats` telling the user to run `xattr -dr com.apple.quarantine
  "/Applications/Loadout.app"` once (works, honest, one manual step); (2) a cask `postflight` that
  runs the same `xattr` (removes the step; whether Homebrew audits or blocks this in third-party taps
  is unverified); (3) System Settings → Privacy & Security → "Open Anyway" (works on recent macOS, more
  clicks). Real fix: Developer ID signing + notarization (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`/API key
  secrets in `tauri-action`), after which the cask needs nothing special.
- **Auto-update:** v1 relies on `brew upgrade --cask`. After notarization, add `tauri-plugin-updater`
  with a signed `latest.json` on GitHub Releases and mark the cask `auto_updates true`. Ranked the
  other way round, an updater on an ad-hoc-signed app would be shipping self-replacing unsigned code.
- **Name and bundle identifier** (decided, Q6): product name "Loadout", identifier
  `com.jhernandezinzunza.loadout`. The app data dir derives from it. Repo:
  `github.com/J-HernandezInzunza/loadout`, public (Q1).

## 8. Agent-SDK readiness (constraints only)

1. `@library/core` imports neither `vue` nor `@tauri-apps/*`; enforced by lint and by the Node-host
   test suite running the whole core.
2. Every operation's input and output is a zod schema exported from `ops`, so tool definitions are
   generated, not hand-written.
3. Every mutation is a plan/apply pair with a fingerprint; an agent can show a plan and apply exactly
   it.
4. Decisions are typed results (`AMBIGUOUS_CATALOG`, `AMBIGUOUS_NAME` with candidates, `REFUSED`,
   `STALE_PLAN`), never prompts; warnings travel in results, never on a side channel.
5. Error codes are a closed, documented enum; messages are for humans, codes for callers.
6. No hidden network in reads; network ops take `AbortSignal` and have timeouts.
7. No module-level singletons: `createLibrary(host)` returns an instance; two instances in one process
   do not share state.
8. All side effects flow through `Host`, and `Host.audit` records every process and destructive file
   operation, so a later agent's actions land in the same log the UI shows.

## 9. Workarounds retired

| behaviors.md §6 | Fate in the new design |
|---|---|
| W1 compile-time tool root | Gone: state lives in the app data dir; nothing to locate |
| W2 `LIBRARY_CWD` anchoring | Gone: global only; any future directory is a typed argument |
| W3 PATH widening | **Remains** (Rust `main`), needed for `git`/`gh` (§5.3) |
| W4 Python picker, W5 bootstrap + exit 3 | Gone: no Python |
| W6 `not_configured` inferred | Gone: "no catalogs registered" is a typed state of `loadConfig` |
| W7 exit-code tolerance, W8 exit-2 disambiguation, W9 refusal text from stdout, W10 `--json`, W13 stderr warnings | Gone: typed `Result` with codes and structured warnings |
| W11 lenient mirrors and dropped fields | Gone: one codebase; `disabled`, `source.exists`, receipt identity reach the UI |
| W12 disjoint dry-run shapes | Replaced by plan/apply with fingerprints |
| W14 `--no-pull` only on list | Gone: explicit refresh policy |
| W15 always-explicit flags | Gone: typed parameters |
| W16 off-thread commands | Changes form: async plugin I/O, chunked hashing |
| W17 command log | **Remains**, redefined as `Host.audit` (processes + destructive fs ops) |
| W18 client-side search | Moves into the core as `searchEntries` |
| W19 error redaction | Deferred with secrets |
| W20 direct file reads | n/a |
| W21 no write serialization | Replaced by in-process queues + single-instance plugin |
| W-UI1 domain logic in `catalog.ts` | Moves into the core; wording stays in Vue |
| W-UI2 intent labels before `command://started` | Mostly replaced by core progress events; a short label stays |
| W-UI3 reload after every write | Gone: writes return updated records / emit change events |
| W-UI4 browser-only mode | Replaced by the in-memory `Library` fake for dev and tests |
| W-UI5 recent project directories | Gone with project scope |

## 10. Risks and open questions (ranked by impact)

1. **Distribution may not launch for users.** Ad-hoc signing + Homebrew quarantine (§7). Question:
   is a Developer ID ($99/year) acceptable before the first teammate install, or is a `caveats`
   `xattr` step acceptable for v1? **Decided:** `caveats` step for v1 (Q2 B).
2. **Catalog byte compatibility.** PyYAML's scalar quoting and the splice quirks must match exactly
   (§3). Mitigation: golden + differential corpus, plus a pre-release diff against real catalogs.
3. **Replicate or fix the splice quirks?** EDIT-10 (blank line), EDIT-12 (drops unknown keys and
   comments). Replicating keeps bytes identical to what a Python user would produce; fixing improves
   data safety but diverges. **Decided:** fix (Q4 C; behaviors.md §0.1 D1–D4).
4. **Remote catalog writes from the app.** Today's UI only edits local catalogs (UI-40); the MVP lists
   add/update/remove including PR mode. Question: enable `direct`/`pr` catalog edits from the UI in v1,
   or keep "local catalogs edited here, shared ones via push/PR"? **Decided:** full parity (Q3 A).
5. **File-level preview needs the network.** Accept that `planInstall` fetches (with offline
   degradation), or show destination-level only when offline? **Decided:** fetch, destination-only
   when offline (Q5 A).
6. **Bundle identifier and data location.** **Decided:** `com.jhernandezinzunza.loadout` (Q6).
7. **Coexistence with the Python CLI on one machine.** A Python `sync` overwrites app-managed copies it
   sees as untracked (SYNC-03); the app then reports them `drifted`. Question: document "don't run both"
   or detect a newer `.installs.json` receipt and say so? **Decided:** document "one tool per
   machine" (Q7 A).
8. **Webview-hosted core performance and fs semantics** (plugin-fs symlink handling, many small IPC
   calls for tree copies). Measured (spikes.md S3): ~6 ms per file read + write, about 10× a native
   copy; the largest real skill takes ~0.2 s. No Rust `copy_tree` needed unless `sync` measures slow.
9. **`git` availability.** The `/usr/bin/git` shim prompts to install Command Line Tools; doctor
   and first run must detect and explain it. With the shell's PATH first (§5.3), a Homebrew git wins
   whenever the user's terminal would use it, so the shim is reached only when no other git exists.
10. **Unmanaged adoption UX.** Report-only (decision) versus an explicit per-item "adopt" (install over
    it with consent). **Decided:** report, plus an explicit per-item replace that asks first (Q8 A).
11. **`skillOverrides` across settings files is undocumented.** Resolved (spikes.md S7): files merge
    per key, so global toggles keep applying in a project unless it overrides that skill. Still
    undocumented, and the key is the directory name rather than the documented frontmatter name
    (S10), so both are worth re-checking on Claude Code upgrades.
12. **Writing a file Claude Code also writes.** `~/.claude/settings.json` is shared with `/config` and
    `/model`. Mitigation: minimal edits, compare-before-write, never overwrite unparseable JSON (§4.5).
13. **Bitbucket's OAuth secret is inside the built app** (§5.5). It is never in the repo (a CI
    secret injected at build time), but anyone with the installed app can extract it. On its own it
    opens no repository: it lets someone build a fake app that shows up as "Loadout" on Bitbucket's
    consent screen, so a teammate who signs in and grants access to that fake hands it a token.
    Mitigations: register the consumer in the Workstand workspace with the narrowest scopes
    (repository read/write, pull requests write); rotate it if leaked (the next build carries the new
    one). Alternatives if that is not acceptable: a small token-exchange service that holds the secret
    (the app sends it the one-time code; adds hosting), or Bitbucket's implicit grant (no secret, but no
    refresh token, so users sign in again every two hours). Either changes only the M4 sign-in work.
    Needs a workspace admin (QUESTIONS.md Q5).
14. **OAuth apps need owners.** Registering the GitHub OAuth app and the Bitbucket consumer (and
    their callback URLs) is outside the code. Not needed until M4; M2/M3 test with injected tokens.
