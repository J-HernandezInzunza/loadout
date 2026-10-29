# Progress

One line per finished task, newest last: `YYYY-MM-DD <task id> <commit> <what changed>` (see Log).

## Old `desktop/src/catalog.ts` exports (M5.02)

Where each export of the old app's `catalog.ts` lives now. "Core" functions are in
`packages/core/src/ops/views.ts` unless noted; "Vue" ones are wording and land with the screen that
uses them.

| Old export | Decides or words | New home |
|---|---|---|
| `Row` | view shape | Vue (M5.06), built from `EntryRecord` |
| `catalogHue` | words (UI-14) | Vue (M5.06) |
| `allRows` | decides: copies of a name side by side | core `groupByName(list())` |
| `winningRows` | decides: the copy that wins, and what it beats | `list()` fields: `overriddenBy === null`, `overrides` (RES-07/08) |
| `catalogRows` | decides: one catalog's copies | `list({ catalog })` |
| `searchRows` | words: ranking (UI-11) | Vue (M5.06) |
| `SESSION_TIMING` | words | Vue (M5.07) |
| `installStatus` | words a decided state | `EntryRecord.state` and `disabled` (global destination only, so no scope or location re-judging); badge text in Vue (M5.06) |
| `archivedPath` | dropped | no parked copies (Q16 B); the off note has no "Parked at" (M5.08) |
| `Dependency`, `dependencies` | decides: declared vs inherited, installed | `show().requires[]`: `direct`, `installed`, `state` |
| `DependentView`, `dependents` | decides: installed | `show().dependents[]`: `direct`, `installed`, `state` |
| `isOnDisk` | decides | `installed` on records and on `show()`'s related entries: one test (§4.10) |
| `editableCatalogs` | decides: write target | `CatalogRow.editable` (WRITE-01: writable, not skipped); M5 also requires `kind === "local"` in Vue until M6 |
| `CatalogDescription`, `describeCatalog` | words | Vue (M5.14) |
| `requirableRefs` | decides: DEP-02 | core `requirableRefs` |
| `AddConsequences`, `addConsequences` | decides: DUPLICATE, override split | core `addConsequences`, sharing `splitOverrides` with `planAdd`'s warnings (pins included, which the old one ignored) |
| `editableCopies` | decides | `show().copies` joined with `CatalogRow.editable` |
| `EntryDraft`, `entryEdits` | decides: the planUpdate fields | core `entryEdits` (returns `setDescription`/`setSource`/`setRequires`) |
| `Purgeable`, `purgeable` | dropped | global only: purge deletes `show().installs`' dests; no scope to block it |
| `PlannedItem`, `InstallPlan`, `installPlan` | decides: target vs dependency, drift gate | `PlanItem.requiredBy` (empty = asked for), `PlanItem.state`; core `discardsEdits(plan)` for the gate |
| `InstalledCopy`, `installedCopies` | decides | `EntryRecord.locations` and `receipt` (`receipt.catalog.id` = from which catalog; null = unmanaged) |
| `PushOutcome`, `describePush` | words | Vue (M5.09), keyed on the push result's `method` |
| `InstallAction`, `describeInstallAction` | words | Vue (M5.11), from plan item states; no project scope |
| `summarizeChanges` | words | Vue (M5.11), from `Preview` |
| `describeDependencyWrite` | words | Vue (M5.13) if sync's dependencies need it; the old states are gone |
| `describeDestState` | words | Vue (M5.11) |

## Log

2026-10-28 M1.01 50d467a rule-coverage test: checked tasks' rule ids must appear in a describe/it/test title
2026-10-28 M1.02 e065f4e model types with zod schemas, closed ErrorCode enum, Result with ok()/err()
2026-10-28 M1.03 184dede sandbox host: per-test temp home/appData, escaping fs paths and cwds fail the test; core tests get their own TS project and may use Node
2026-10-28 M1.04 0dd4642 strict zod readers for the six golden fixtures, expected(), replaySplice(), materializeTree()
2026-10-28 M1.05 412489a pyyamlInline: all 4,689 scalar.json outputs byte-equal; MULTILINE_VALUE when the emitted scalar would span lines (a double-quoted \n is accepted, per the fixture)
2026-10-28 M1.06 3cfe152 renderEntry passes all 8 render cases (rebuild for the 3 refused refs); validateRef checks A11 characters, then DEP-11's type:name
2026-10-28 M1.07 832f990 spliceEntry: all 309 insert cases where library.py and the rebuild agree pass, batches included; Python whitespace, dot and string-order semantics kept
2026-10-28 M1.08 850c298 D2 layout check (assertSpliceable) with code and 1-based line: 28 of 48 SPLICE_UNSUPPORTED cases; the other 20 are D1 refusals into missing sections, left to M1.09
2026-10-28 M1.09 5cb0c1e D1: inserts create a missing section in canonical order; 132 missing-section cases pass, incl. M1.08's 20 deferred refusals; 36 create-then-remove round trips wait for M1.10
2026-10-28 M1.10 edf838d removeEntry (D3): all 330 cases with a remove pass, incl. M1.09's 36 round trips
2026-10-28 M1.11 727a4e4 replaceEntry (D4): all 896 splice.json cases now replay as expected; test-only assertSpliceable removed
2026-10-28 M1.12 d9cf9ad parseCatalog (yaml failsafe + PyYAML's exact resolvers), catalogEntries with typed field/structure problems, verifyEdit (VERIFY_FAILED), sortedProblems; all 66 read.json cases
2026-10-28 M1.13 29e8d78 scaffoldCatalog: same YAML as the CLI's scaffold, Loadout comments; accepts an insert into each section
2026-10-28 M1.14 3074272 parseSource/cloneUrls/remoteWeb: all 47 source.json cases (sandbox home); new INVALID_SOURCE error code
2026-10-28 M1.15 0647edc config store: strict AppConfigV1, no-catalogs state, queued atomic saves, an invalid file is CONFIG_INVALID (new code) and never overwritten
2026-10-28 M1.16 5abd1af validateRegistry: all 31 registry.json problem lists, in order; parseYamlMaps keeps YAML key types
2026-10-28 M1.17 7eb7f0e planImport/applyImport: catalogs match every valid registry.json case; quoted flags read strictly and reported; dropped/unknown keys reported; STALE_PLAN and REFUSED guards; Host gains fs.realPath
2026-10-28 M1.18 6bfacc8 loadRegistry: skip reasons (not cloned yet / not found / can't parse), RCAT-08 single and all-unreadable errors (new NO_READABLE_CATALOG), winners keyed by name
2026-10-28 M1.19 5db5e2d resolve/resolveAll/candidates: pins applied to the merged list (slots only, inert when absent), catalog-scoped lookup with UNKNOWN_CATALOG (new code)
2026-10-28 M1.20 64cbccb overrideSplit/copies/records: provenance relative to each copy (overriddenBy = winner, overrides = later copies), pinned; install fields stubbed
2026-10-28 M1.21 322ec72 resolveDeps (post-order, own catalog, cycle recorded on the parent per A29), mergeOrders, dependents, findCycles; unknown-type refs are not_found everywhere (A25)
2026-10-28 M1.22 d3ca107 createLibrary: list/search/show/catalogs with zod input/output schemas per op; offline, no shared state; install fields stubbed until M2.20
2026-10-28 M2.01 2e40917 git harness: bare repos as file:// remotes, https github/bitbucket mapped via sandbox gitconfig, ssh unmapped and refused, blobless filter allowed
2026-10-28 M2.02 f4def17 Host.secrets (Node: in memory per instance) and Host.http (fetch, TimeoutError/AbortError); Tauri stub rejects both; sandbox treats non-loopback HTTP as an escape; offline profile allows loopback
2026-10-28 M2.03 acc9219 API stub (user, Bitbucket refresh, PR create/list, duplicates, recorded requests, failNext) and core ApiBases; Bitbucket's duplicate-PR body is unverified (400 in the stub), so M3.01 should find duplicates by listing
2026-10-28 M2.04 1fafaf7 createAccounts: connect (whoami first, secret rolled back on a config failure), disconnect, accounts, tokenFor with Bitbucket refresh (60 s margin); tokens only in secrets; new codes NOT_CONNECTED/AUTH_FAILED/API_FAILED; store.updateConfig
2026-10-28 M2.05 153a4d7 createGitClient: urlsFor/clone/lsRemoteHead/probe/revParse/pullFfOnly/behindCount; token via credential helper + env (checked with git credential fill, as arch §6 says); GitHub user x-access-token; GIT_SSH_COMMAND always set; new GIT_FAILED
2026-10-28 M2.06 0a45438 createOperation (tmp/op-*, CloneCache + ProbeCache keyed by repoKey, promise-memoized incl. failures, dispose) and sweepTemp at launch
2026-10-28 M2.07 413109a contentHashV1 (all 20 hash.json digests) and fileManifest (relpath -> sha256 hex) over one walk; code-point path order
2026-10-28 M2.08 28227de createReceiptStore: get/all/put/delete, sorted v2 file, queued read-modify-write (50 concurrent puts survive), crash mid-write keeps the old file; unreadable file reads empty + warning, writes refused (new RECEIPTS_INVALID)
2026-10-28 M2.09 8d1af8b refreshCatalogs (clone/pull per catalog, warnings not failures, A20 origin check) and catalogStatus (behind/ahead/diverged, unknown offline); git behindCount -> divergence + originUrl; GitHub/Bitbucket catalog repos get FETCH-02 URL order
2026-10-28 M2.10 5f420b9 destFor/destState/scanInstallDirs: top level only, every origin (python-cli via legacy .installs.json, symlink unfollowed, parked, foreign), per-file drift, missing receipts; install dirs under ~/.claude regardless of CLAUDE_CONFIG_DIR
2026-10-28 M2.11 3783cf4 fetchEntry stages into the op dir (remote via CloneCache, local with FETCH-08 overlap check), no top-level .git, real SKILL.md/file verification; new SOURCE_MISSING; op.path()
2026-10-28 M2.12 05891d5 checkUpdate (up-to-date/unmoved/changed, receipt advance), contentUnmoved, isStale, op.heads memo; a repointed source is changed even at an identical commit (stricter than the CLI)
2026-10-28 M2.13 1c7146a planInstall: resolve-all, merged closures with requiredBy, per-item state/provenance/consent, file preview with editedLocally, unreachable -> destination-only, failed items kept, fingerprints; discardPlan
2026-10-28 M2.14 e88fbd8 applyInstall: all checks before effects (STALE_PLAN, discarded plan, consent by exact path), backup-beside + rename-in with restore on failure and EXDEV copy fallback, v2 receipts, stop-at-first-failure, abort, progress; discards the plan
2026-10-28 M2.15 bad3e94 createClaudeSettings: readSkillOverrides/editSkillOverrides; strict-JSON gate, minimal jsonc edits (byte-identical elsewhere), real-file writes, mode kept, one re-read on concurrent change, configDir for CLAUDE_CONFIG_DIR; jsonc-parser 3.3.1
2026-10-28 M2.16 df1668b setSkillState (rules 1, 5, 6; Q14 A read-only values; Q15 A agents refused) and managedSkillOverrides (rule 4; JSON file only, MDM plist not readable)
2026-10-28 M2.17 105bbc3 planMigrateParked/applyMigrateParked: off written first, rename or EXDEV copy-verify-delete, occupied and symlink-bearing cross-volume copies left and reported; skills only (the CLI parked nothing else)
2026-10-28 M2.18 97f959f uninstall: deleted/pruned/absent/refused per item, forcePaths by exact path, override removed and reported (Q17 A), names resolvable from receipts after leaving the catalog
2026-10-28 M2.19 a078bc8 planSync/applySync: managed winners only, closures deduped, up-to-date/unmoved skipped (force refetches), unmanaged reported not overwritten, per-item failures, dependency writes, missing after the run; install shares buildItem/checkItems/installItem; unmoved receipt advance happens at plan time
2026-10-28 M2.20 74e3f8a list/show install fields (winner only; RES-08 subject re-derived), show.installs by type, disabled from overrides, list checkRemote -> stale; facade scan()/refresh() with schemas; createLibrary(host, { git, claudeConfigDir })
2026-10-28 M2.21 9d00c99 planAddCatalog/applyAddCatalog (prove before save, explicit protected), initCatalog (A18), removeCatalog (A19 global purge incl. overrides, clone purge); refresh outcome 'cached' for a failed pull
2026-10-28 M2.22 310101d doctor (checks 3, 4, 7-10, 13-31 + git/xcode, accounts, managed, diverged with recloneCatalog); xcode-select inferred from git --version (HostProc runs git only); check 10 asks for the catalog's branch
2026-10-28 M3.01 4ed2782 createPullRequest for GitHub and Bitbucket: create, duplicate -> existing PR by listing the head branch, expired-token refresh via tokenFor, AUTH_FAILED/API_FAILED/NOT_CONNECTED
2026-10-28 M3.02 26c4a0e writeTarget: add (named / only writable / NO_WRITABLE_CATALOG / AMBIGUOUS_CATALOG with ids) and update/remove (resolved-from catalog, holders in order, optional type)
2026-10-28 M3.03 2321b61 computeEdit (from the exact text, field no-op, verify), planCatalogEdit/applyCatalogEdit (fingerprint, STALE_PLAN, atomic), unifiedDiff (difflib ranges, deletions first), WriteResult + inPlaceResult
2026-10-28 M3.04 3ee09be planLocalWrite/applyLocalWrite: atomic in-place write, no git even in a work tree, committed/pushed false, dry-run diff by basename
2026-10-28 M3.05 2958669 planDirectWrite/applyDirectWrite (refresh, edit, commit, push HEAD:<branch>; commit/push failures are warnings; stale push leaves a diverged clone); git commit/push + pushError (WRITE-09); editCopy (WRITE-12)
2026-10-28 M3.06 85c64a0 planPrWrite/applyPrWrite (temp clone, branch with seconds and -N suffix, commit, push -u, API PR or manual compare URL, warnings on API failure, existing PR = success, dry run = git show HEAD); gh removed from HostProc, shell scope and capabilities test
2026-10-28 M3.07 c10e76c suggestSource (GitHub blob / Bitbucket src URL on the checked-out branch, folders -> main file, a reason for each miss); git repoOf via symbolic-ref
2026-10-28 M3.08 3c05c73 planAdd/applyAdd (CLI check order, WRITE-05 with URL hint, WRITE-06, A9/Q13d refusals, DEP-10/11, override warnings, batch = one write) and the write-mode dispatcher; a remote catalog must be cloned (launch refresh) to be a write target
2026-10-28 M3.09 e426b89 planUpdate/applyUpdate (set/add/remove requires against the fresh text, setSource checked like add minus existence, field no-op, D4 keeps unknown keys and comments, DEP-10 and redundancy warnings); shared checkSource/checkRefs
2026-10-28 M3.10 2abf966 planRemove/applyRemove: DEP-09 dependents warning, EDIT-10 through the write mode, purge = forced uninstall after the write (not on dry runs); uninstall gains types
2026-10-28 M3.11 409b375 planPush/applyPush: local source replaced in place (stage + rename), remote via temp clone + library/update-<name>-<ts> + PR (pushAndOpenPr shared with PR mode); STALE_PLAN on copy/target change; provenance note by catalog key; A28 receipt files refreshed when it describes the same source; repo-root skills and symlinked copies refused
2026-10-28 M3.12 3aea0c5 planPin (RES-13 refusals, RES-14 onlyHolder, RES-15 assessment by catalog key: stale/blockers/unresolved/newDependencies/dependents), applyPin (STALE_PLAN on a changed pin; switchInstalled installs a simple switch, re-assessed after), unpin (RES-17); global only so project/parked blockers are moot
2026-10-28 M3.13 49523f8 milestone check (no code change; verified at 49523f8): all 33 mvp WRITE/EDIT rules in test titles; npm run check green (1850 tests); golden:check clean; deviation report byte-identical to the one approved in Q1; M2.23 (manual Bitbucket smoke, no rules) is the only unchecked task
2026-10-29 M4.01 1f6332a facade: planInstall/applyInstall, uninstall, setSkillState, planMigrateParked/applyMigrateParked, planSync/applySync, discardPlan over one per-instance ctx (accounts + API bases included); plans branded (Issued<P, B>) and opaque in the schemas (z.custom + brand, must carry items); SyncPlan carries its catalog, so applySync takes only the plan
2026-10-29 M4.02 256157e facade: pins() (sorted by name, holders in registry order, dangling, resolvesTo), doctor, recloneCatalog, planAddCatalog/applyAddCatalog (returns the new registry, not a CatalogRow as arch §2.3 sketches), initCatalog, removeCatalog, planImport/applyImport (branded plans), accounts/connect/disconnect; managedSettingsFile as a test-only option
2026-10-29 M4.03 30f0982 facade: planAdd/planUpdate/planRemove -> one CatalogEditPlan ({ op } & plan), applyCatalogEdit dispatches and tags the result with op, discardCatalogEdit (PR temp clone gone, tested); planPush/applyPush/discardPush, planPin/applyPin/unpin, suggestSource (wrapped in ok); WriteResult schema loose so CatalogEditResult can intersect it
2026-10-29 M4.04 ead0ff1 contract.test.ts (TS compiler API over interface Library; gaps both ways; each schema's removal proven to fail); test/checkedLibrary.ts proxy parses every facade result's warnings/error against Warning/CoreError in all facade tests; createFakeLibrary (@loadout/core/testing): seeded reads (list/search/show/catalogs/pins/scan/refresh/doctor/accounts), mutations REFUSED unless overridden (thin on purpose; M5 grows it)
2026-10-29 M4.05 ee33298 launch({ signal }): sweepTemp, loadConfig (state no-catalogs|ready; an invalid config is the error), refreshCatalogs with per-catalog warnings; reads never waited on it already (they don't pull); schema + fake (remote catalogs only, 'cached'; fake refresh fixed to remotes too)
2026-10-29 M4.06 94a3f2c host-tauri/{index,fs}.ts: HostFs over plugin-fs (atomic write = temp beside + rename, old mode via create mode since the plugin has no chmod; ENOENT/EXDEV from 'os error N'); realPath via a new real_path Rust command behind an app manifest (Q6, assumed A); mockIPC tests with an in-memory tree (invoke swapped after mockIPC, since mockIPC drops the write path headers); capabilities test: exact allow list, exact app commands
2026-10-29 M4.07 f24d59c host-tauri/proc.ts (Command.spawn, processGroup: true, kill on timeout/abort, 137 for SIGKILL, AbortError, lines concatenated), audit.ts (ring buffer, capacity 1000, subscribe), tauriPaths() via the path plugin, sha256 via crypto.subtle; createTauriHost(paths, log); mockIPC shell fake drives the Channel directly
2026-10-29 M4.08 13e8cbb src-tauri/src/secrets.rs (keyring 3.6.3 apple-native, not 4.x: 4 needs Rust 1.88 > crate's 1.85; get->None on NoEntry, delete ok on NoEntry; pure fns over an Entry so the mock store's per-entry password can be tested), commands in build.rs manifest + capability; host-tauri/secrets.ts over invoke with Error wrapping
2026-10-29 M4.09 2d941a9 tauri-plugin-http 2.8.3 (crate + JS, exact); host-tauri/http.ts (AbortSignal.any of signal + timeout, raced so cancel settles at once with the signal's reason); http:default scoped to the four URLs, pinned by the capabilities test; mockIPC fake of fetch/fetch_send/fetch_read_body/fetch_cancel
2026-10-29 M4.10 359c946 path.rs: shell-env.json in ~/Library/Application Support/<identifier> ({path, claudeConfigDir}, temp+rename); cache hit used at once, refresh_cache thread started only after set_var (env race); miss/corrupt -> inline probe, cached if PATH non-empty; probe_login_shell(shell, timeout) so tests use fake shells instead of SHELL; cargo tests: miss, hit (<500 ms with a 1 s shell, then refreshed), timeout, corrupt
2026-10-29 M4.11 a7eafa7 (code only; task stays unchecked until the Finder check) main.ts + DebugView.vue (status, warnings, catalogs, entries with state/off, live audit log; import-from-CLI button in the no-catalogs state, since this machine has no config.json yet); claudeConfigDir read from the Rust shell-env.json cache; spike/ and App.vue removed; debug bundle builds: apps/desktop/src-tauri/target/debug/bundle/macos/Loadout.app
2026-10-29 M4.11 a7eafa7 owner launched the debug build from Finder: imported the CLI registry, catalogs and entries listed, launch's git calls in the audit log
2026-10-29 M4.16 53e41f1 owner's Finder-launched smoke: launch pull, install (intent-review from shared, triage-bug closure planned), sync up to date via ls-remote, doctor, PR-mode write pushed library/update-grilling-20261029T075931 with a compare URL; written up as spikes.md S11; M2.23 ticked with a pointer
2026-10-29 M4.12 b35f98e S12: GitHub device flow works alone (repo scope, non-expiring token, no secret); Bitbucket redirect to loadout://oauth/bitbucket reaches the Finder-launched app via tauri-plugin-deep-link 2.4.10 with state intact; chosen per host, loopback recorded as the fallback; Q5 resolved
2026-10-29 M4.13 16fd6e5 GitHub device flow: beginSignIn/completeSignIn (interval + slow_down, SIGN_IN_DENIED/EXPIRED, CANCELLED, SIGN_IN_UNAVAILABLE without a client ID), githubLogin API base and stub device endpoints; owner signed in for real from the Finder-launched debug build
2026-10-29 M4.14 e08324c Bitbucket authorization code to loadout://oauth/bitbucket: state checked before any exchange, code exchanged with the consumer (secret via Vite env, ships in builds per Q5), refresh token stored and used by M2.04; window focused with "you can close the browser tab"; owner signed in for real
2026-10-29 M4.15 b1acfc1 checkAccount(on) on the facade (tokenFor + whoami); debug view Accounts section: sign in, check, disconnect per host; owner connected, checked and disconnected both hosts; config.json's strict schema and the git/fs-only audit log keep tokens out
2026-10-29 M4.17 b1acfc1 milestone check (no code change): npm run check green (1970 TS + 15 Rust tests); facade contract test passes for all 43 Library methods; capabilities test pins fs (exact allow + denies), shell (git only), http (four URLs) and the app commands (real_path + three Keychain); every M4 task checked
2026-10-29 M5.01 67687f2 rule coverage scans apps/ (fixture-tree proof with UI-20); services.ts injection keys (libraryKey, auditLogKey; useLibrary/useAuditLog for setup stores via app-level provide); testing/mountView (fresh Pinia + seeded fake + audit log, sync mount); @loadout/core/testing seed builders and seededState() (every install state, off skill, override, pin, account), parsed against the ops schemas
2026-10-29 M5.02 d150380 show requires/dependents gain direct/installed/state; CatalogRow.editable (writeTarget add by name); views.ts: groupByName, requirableRefs, addConsequences (splitOverrides shared with planAdd, pins count), entryEdits (setDescription/setSource/setRequires or null), discardsEdits (drift gate); export map table at the top of PROGRESS.md, which now has a Log heading
