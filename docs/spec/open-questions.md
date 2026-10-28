# Open questions for the rebuild

Answered 2026-10-28. The answers are applied to the spec in `behaviors.md` §0.1 and inline in
`architecture.md`.

Fill this in and hand it to the first session of the new repo. References like `EDIT-10`, `UI-40`
or `A8` point at rule ids in `behaviors.md`; `arch §4` points at `architecture.md`.

**How to answer.** Tick one box, or write under *Answer*. In the tables, leave *Your call* blank to
accept the recommendation, or write what you want instead. Anything left blank is taken as "go
with the recommendation."

**Blocks** says when an answer is needed:


| Code | Needed before                                                 |
| ---- | ------------------------------------------------------------- |
| S0   | scaffolding the new repo                                      |
| M1   | the catalog core (parse, splice, config, import)              |
| M2   | install, sync, uninstall, disable/enable, unmanaged detection |
| M3   | authoring writes (add, update, remove, push, pin)             |
| UI   | building screens                                              |
| R    | the first release to teammates                                |


---

## Part 1. Decisions only you can make

### Q1. Where does the new repo live, and is it public? (Blocks: S0, R)

Homebrew installs the cask by downloading the release asset. A private GitHub repo's release assets
need an auth token, which a plain `brew install --cask` doesn't send. Today's repo has two remotes:
`github.com/J-HernandezInzunza/the-library-skill` and `bitbucket.org/sedteam/the-library-skill`.









- [x] A. Public GitHub repo under your personal account (works with a personal tap as planned)
- [ ] B. Private GitHub repo, with release assets published somewhere public
- [ ] C. Private repo; teammates build from source or download releases by hand (drops the one-command install)
- [ ] D. Workstand org (GitHub or Bitbucket): say which, and who owns releases

Repo name: [https://github.com/J-HernandezInzunza/loadout](https://github.com/J-HernandezInzunza/loadout)

### Q2. Signing: Developer ID before the first teammate install? (Blocks: R)

Homebrew 5.0 deprecated `--no-quarantine` and casks without code signing; a later release reportedly
removed the flag. An ad-hoc-signed app installed by `brew` keeps the quarantine attribute and
Gatekeeper blocks its first launch (arch §7).









- [ ] A. Get a Developer ID ($99/year) and notarize before teammates install **(recommended)**
- [x] B. Ad-hoc signing for v1; the cask's install notes tell users to run `xattr -dr com.apple.quarantine "/Applications/The Library.app"` once
- [ ] C. Ad-hoc signing; the cask runs that `xattr` itself after install (unverified that Homebrew allows this in a personal tap)
- [ ] D. Skip Homebrew for v1; a DMG on GitHub Releases plus "Open Anyway" instructions

If A: personal Apple account or Workstand's? \_\_\_\_\_\_

### Q3. Should the app edit remote (shared) catalogs? (Blocks: M3, UI)

Today's app only edits **local** catalogs. That was a deliberate product rule ("a review event that
belongs in that repository's own workflow", UI-40). The CLI can write to remote catalogs: protected
ones through a PR, unprotected ones by direct push. Your MVP list includes add/update/remove and "PR
mode via gh".









- [x] A. Full parity with the CLI: protected remotes get a PR, unprotected remotes a direct push (UI asks for confirmation on direct) **(recommended)**
- [ ] B. PR mode only: the UI edits protected remotes through a PR and refuses unprotected (direct) remotes
- [ ] C. Keep today's rule: local catalogs only; shared catalogs change through push/PR of an installed copy

Answer / notes:

### Q4. Copy the CLI's splice quirks exactly, or fix them? (Blocks: M1)

When the CLI removes or updates an entry it also removes the blank lines below it, and `update` drops
any non-standard keys and comments inside the entry (EDIT-10, EDIT-12, A10). Copying keeps the
app's diffs byte-identical to what a Python-CLI teammate would produce; fixing protects data but the
two tools then disagree on the same edit.









- [ ] A. Copy exactly in v1, revisit once nobody uses the Python CLI **(recommended)**
- [ ] B. Fix blank-line handling, keep the rest
- [x] C. Fix all three (keep unknown keys and comments on update)

### Q5. File-level install preview needs the network. OK? (Blocks: M2, UI)

Today's preview only lists destinations. To show "these files change, and you edited these two" the
app has to fetch the source before you confirm (arch §5.2).









- [x] A. Fetch during preview; when offline, fall back to a destination-only preview **(recommended)**
- [ ] B. Destination-only preview, as today; file changes shown after install
- [ ] C. Destination-only by default, with a "Show file changes" button that fetches

### Q6. App name and bundle identifier (Blocks: S0)

The app's data folder (`~/Library/Application Support/<identifier>/`) derives from the identifier,
so changing it later means migrating everyone's config. Today: name "The Library", identifier
`com.josehernandezinzunza.desktop`.









- [ ] A. Keep both
- [x] B. Name: "Loadout", identifier "loadout" (settled 2026-10-28 as `com.jhernandezinzunza.loadout`: bundle ids are reverse-DNS)

### Q7. What happens if a teammate runs the app and the Python CLI on the same machine? (Blocks: M2)

A Python `sync` overwrites app-installed copies it sees as untracked; the app then reports them as
edited (SYNC-03).









- [x] A. Document "one tool per machine"; the app just reports what it finds **(recommended)**
- [ ] B. The app also reads the CLI's `.installs.json` and says when the CLI touched a copy more recently
- [ ] C. Both tools share one receipts file (contradicts "config and receipts are app-owned")

### Q8. Content the app didn't install (Blocks: M2, UI)

The decision is to *report* unmanaged content. The question is whether the app can ever replace it.









- [x] A. Report it, and offer an explicit per-item "Replace with the catalog's copy" that asks first **(recommended)**
- [ ] B. Report only; the app never touches unmanaged content

### Q9. Port today's UI, or redesign? (Blocks: UI)

`behaviors.md` §4 documents every current screen, string and spec. Porting makes those specs the
acceptance tests; a redesign means new specs.









- [x] A. Port the current screens, wording and design tokens, fixing the gaps in §4.10 **(recommended)**
- [ ] B. Keep the structure, redesign the visuals
- [ ] C. Redesign (please describe what should change)

### Q10. When to open PRs automatically (Blocks: M3)

Today `autopush` is one global setting. When it's off the CLI pushes a branch and shows a link to open
the PR yourself; when it's on and `gh` fails, the CLI errors after the branch is already pushed.
Bitbucket never gets an automatic PR.









- [x] A. Drop the setting: open the PR with `gh` whenever it's installed and signed in, otherwise show the link **(recommended, one less knob)**
- [ ] B. Keep one global setting, as today
- [ ] C. Per-catalog setting (a roadmap item)

### Q11. Settings that may not earn their place (Blocks: M1)

The import has to know what to keep. The app never sends the CLI flags behind the last three, and
nothing in the CLI writes `default_add_catalog`. Tick to keep; unticked ones are dropped (and the
import reports them).









- [ ] `default_dirs` override (install to somewhere other than `~/.claude/...`)
- [ ] `default_add_catalog` (which catalog "add" targets when several are writable)
- [ ] `git_commit` on local catalogs (commit and push the file after each edit)
- [x] `writable: false` (register a catalog read-only)
- [x] Pins (recommended: keep; the UI already has a full pin flow)

### Q12. First run with nothing to import (Blocks: UI)

A new teammate has no Python CLI config.









- [x] A. Ask for a catalog (paste a repo URL, or create a personal one) **(recommended)**
- [ ] B. Also offer the team's shared catalog as a one-click choice. Repo URL \_\_\_\_\_\_ , branch \_\_\_\_\_\_

### Q13. Smaller scope calls (the `mvp?` items in behaviors.md)


| #   | Item                                                                             | Recommendation                                                | Your call                                                                              |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| a   | Batch add (several entries in one commit/PR), §3.12                              | Keep in the core, no UI in v1                                 | sounds good                                                                            |
| b   | Source-URL suggestion for a local file in Add entry, §3.13                       | Keep (it's what stops local paths landing in shared catalogs) | sounds good                                                                            |
| c   | Animated README demos (`desktop/demo/`), §4.9                                    | Drop for v1                                                   | i want the infras setup to record workflows in the native app, could be a roadmap item |
| d   | Root-level skill sources that copy `.git` into `~/.claude/skills` (FETCH-10, A8) | Refuse them on add; install existing ones but skip `.git`     | yeah refuse that, explain why                                                          |
| e   | Bitbucket PRs through its API (needs a token)                                    | Not in v1; keep the "open PR" link                            | sounds good                                                                            |


### Q14. Which skill states should the app offer? (Blocks: M2, UI)

Turning skills on and off is decided: the app writes `skillOverrides` in `~/.claude/settings.json`
instead of moving folders (arch §4.5). Claude Code supports four values: `on`, `name-only` (Claude
sees the name only), `user-invocable-only` (hidden from Claude, you can still type `/name`), `off`.









- [x] A. On/off only, as today; show the other two read-only if you set them elsewhere **(recommended)**
- [ ] B. All four states in the UI

### Q15. Toggle prompts and agents too? (Blocks: M2, UI)

Today only skills can be switched off. Claude Code merges `~/.claude/commands/*.md` into skills, so
prompts should toggle through the same setting (to verify). Agents have no `skillOverrides`; the
documented switch is a `permissions.deny` rule, `Agent(<name>)`, which blocks the agent rather than
hiding it and can't be undone per project.









- [x] A. Skills and prompts in v1; agents later **(recommended)**
- [ ] B. Skills only, as today
- [ ] C. Skills, prompts and agents (agents through `Agent(name)` deny rules)

### Q16. Skills the Python CLI already switched off (Blocks: M2)

Those were moved to `~/.claude/skills-disabled/`. The app will find them (arch §4.4).









- [ ] A. Show them as "off (parked by the Python CLI)" with a one-click "move back and keep off" **(recommended)**
- [x] B. Migrate them all automatically on first launch, after showing the list
- [ ] C. Leave them alone and say nothing

### Q17. Uninstalling a skill that's switched off (Blocks: M2)

The `"off"` entry is keyed by name, so if it stays it would also hide any future skill with that
name, in any project.









- [x] A. Remove the entry on uninstall, and say so in the confirmation **(recommended, simplest)**
- [ ] B. Keep the entry
- [ ] C. Remove it only if the app wrote it (the app keeps a list of the entries it wrote)

---

## Part 2. Facts only you know

Answer what you can. For F1 and F2 I can instead run a read-only scan of your real catalogs if you
tell me where they are.

**F1.** Which hosts do catalogs and sources live on? (The parser only accepts github.com and
bitbucket.org URLs, branch names without `/`.) ☐ only those two ☐ also: \_\_\_\_\_\_  
Answer: Only those two

**F2.** Do any real catalogs contain: entries indented with 2 spaces instead of 4 ☐; an inline
`[ ]` (with a space) ☐; a comment on the `library:` line ☐; a missing `skills`/`agents`/`prompts`
section ☐; extra keys on entries (e.g. `tags:`) ☐; Windows line endings ☐; source branches with `/`
☐; a skill whose `SKILL.md` is at the repo root ☐? Each one breaks or changes CLI writes (EDIT-04..09).  
Answer: No, i dont think so

**F3.** Who uses what today, and for how long will the Python CLI stay in use? (Sets how long byte
compatibility must hold.)
Teammates: \_\_\_\_  Python CLI users: \_\_\_\_  Desktop app users: \_\_\_\_  Agent `/library` users: \_\_\_\_
Python CLI retired by: \_\_\_\_  
Answer: I dont imagine I want people to keep using the Python CLI

**F4.** Is the team's shared catalog on GitHub or Bitbucket, and is it protected (PRs)? \_\_\_\_\_\_
Do teammates have `gh` installed and signed in? ☐ yes ☐ some ☐ no  
Answer: It is on bitbucket, and it is protected, some people have gh installed, im open to other ways to bring git bundled with this app

**F5.** Does anyone rely on `--project` installs today? (Dropped in v1; the app will ignore those
copies.) ☐ no ☐ yes, who/what: \_\_\_\_\_\_  
Answer: Not really, this is better left curated by hand today

**F6.** Any teammates on Intel Macs? ☐ no (build Apple Silicon only) ☐ yes (universal build)  
Answer: No

**F7.** Which real catalogs should the pre-release compatibility check run against? (arch §3.2,
step 4: the new app's edits are diffed against `library.py`'s on copies of them.) \_\_\_\_\_\_  
Answer: both my personal and team catalog can be used

---

## Part 3. Architecture recommendations to accept or change

From `architecture.md`. Blank means accepted.


| #   | Choice                | Recommendation                                                                                                                 | Main alternative                    | Blocks | Your call                                                      |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------ | -------------------------------------------------------------- |
| R1  | Where the core runs   | In the webview, behind a `Host` interface, with a Node implementation for tests and the later agent work (arch §2.1)           | Node sidecar process                | S0     |                                                                |
| R2  | Rust's job            | No app commands; plugins (fs, shell, dialog, opener, single-instance) plus PATH widening at startup (arch §2.4)                | Rust commands for copying/hashing   | S0     |                                                                |
| R3  | File access scope     | All of `$HOME` except `~/.ssh`, Keychains and `~/.gnupg`, plus the app data folder (arch §2.4)                                 | Narrow scope plus per-path grants   | S0     |                                                                |
| R4  | Toolchain             | npm workspaces (matches today), TypeScript, Vite, Vitest, Vue 3, Pinia, ESLint import-boundary rule                            | pnpm                                | S0     |                                                                |
| R5  | Catalog writes        | Hand-port the CLI's line-based splice and PyYAML's quoting, proven by golden files generated from `library.py` (arch §3)       | `yaml` package CST                  | M1     |                                                                |
| R6  | Config                | JSON in the app data folder, `protected` stored explicitly (arch §4.1)                                                         | YAML                                | M1     |                                                                |
| R7  | Import                | Once, from `config.local.yaml` found through the `~/.claude/skills/library` symlink; receipts not imported (arch §4.2)         | Import receipts too                 | M1     |                                                                |
| R8  | Receipts              | Per-file hashes, so the preview can say which files you edited (arch §4.3)                                                     | One hash per install, as today      | M2     |                                                                |
| R9  | Unmanaged scan        | Top-level items in each install folder only (arch §4.4)                                                                        | Recursive, as the CLI does          | M2     |                                                                |
| R10 | Disabled skills       | **Decided 2026-10-28:** `skillOverrides` in `~/.claude/settings.json`, no folder moves (arch §4.5); see Q14 to Q17             | n/a                                 | M2     | decided                                                        |
| R11 | Git                   | System `git` and `gh`; keep the CLI's fetch and update-detection strategy, with the `refs/heads/<branch>` fix (arch §5)        | isomorphic-git / gitoxide           | M2     |                                                                |
| R12 | When to pull catalogs | On launch, on Refresh, and inside writes; reads never pull (arch §2.5)                                                         | Pull on every read, as the CLI does | M2     |                                                                |
| R13 | Mutations             | Every change is a preview (plan) plus apply, refusing to apply a stale plan; errors are typed codes (arch §2.3)                | Single-call operations              | M1     |                                                                |
| R14 | Install safety        | Copy into a temp folder, then rename into place (arch §5.2)                                                                    | Delete then copy, as today          | M2     |                                                                |
| R15 | Tests                 | Real git against local `file://` repos, network blocked; UI tests against an in-memory fake (arch §6)                          | Mocked git                          | S0     |                                                                |
| R16 | Releases              | GitHub Actions universal build; cask in your tap; updates via `brew upgrade` until notarized, then the Tauri updater (arch §7) | Updater from day one                | R      |                                                                |
| R17 | Agent readiness       | The constraints in arch §8 (no UI imports in core, schemas for every operation, plan/apply, typed errors)                      | Defer until the agent iteration     | S0     |                                                                |
| R18 | macOS floor           | 10.15, as today                                                                                                                | Newer floor                         | S0     | newer floor is fine, some 14.x version i think is a good floor |


---

## Part 4. The CLI's accidental behaviors: keep or fix

From `behaviors.md` §7.1, minus the ones that disappear with the CLI. **Keep** means copy the CLI;
**fix** means the recommendation. Blank means the recommendation.


| #   | What the CLI does                                                                                    | Recommendation                                              | Your call              |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------- |
| A1  | `sync` reinstalls a disabled dependency, leaving two copies                                          | Moot: nothing is parked any more                            | fix                    |
| A2  | `sync` overwrites hand-installed copies that share a catalog name                                    | Fix: never without consent (follows the unmanaged decision) | fix                    |
| A3  | One unreachable, never-cloned remote catalog makes every command fail                                | Fix: skip it with a reason                                  | fix                    |
| A4  | A failed direct push leaves the catalog clone permanently diverged                                   | Fix: doctor detects it and offers a re-clone                | fix                    |
| A5  | Update detection can read the wrong branch (`feature/main` matches `main`)                           | Fix: match `refs/heads/<branch>` exactly                    | fix                    |
| A6  | "Behind upstream" warning goes quiet when offline                                                    | Fix: say "couldn't check"                                   | fix                    |
| A7  | The "main file verified" check can never fail                                                        | Fix or drop it                                              | fix (2026-10-28: a skill needs `SKILL.md`, an agent/prompt its `.md` file, checked before the copy lands) |
| A8  | Root-level skill source copies the whole repo, `.git` included                                       | See Q13d                                                    | see Q13 answer         |
| A9  | A skill source pointing at a folder installs that folder's parent                                    | Keep for existing entries; refuse on add                    | sounds good            |
| A10 | Splice quirks (blank lines, dropped keys and comments)                                               | See Q4                                                      | see Q4 answer          |
| A11 | `requires` refs aren't escaped (a `"` breaks the file)                                               | Fix: validate refs when entered                             | fix                    |
| A12 | Unusual catalog formatting produces broken YAML (then rejected)                                      | Fix: clear "can't edit this catalog's layout" error         | fix                    |
| A13 | A missing section is never created                                                                   | Keep (compat); explain it in the UI                         | fix                    |
| A15 | Two identical PR writes within a minute collide on the branch name                                   | Fix: add seconds or a suffix                                | fix                    |
| A18 | `catalog init ~/x` creates a file literally named `x`                                                | Fix: add `library.yaml` when the path isn't a `.yaml` file  | fix                    |
| A19 | Unregistering a catalog with "delete its installs" misses disabled copies and reaches other projects | Fix: global only (parked copies are moot)                   | fix                    |
| A20 | Re-adding a catalog id reuses its old clone without checking the URL                                 | Fix: check the clone's origin                               | fix                    |
| A21 | `catalog add` makes remotes direct-push by default; config without the key means PR                  | Fix: store it explicitly; UI defaults to PR                 | fix                    |
| A22 | A quoted `"false"` reads as true for several config flags                                            | Fix during import: report and read it strictly              | fix                    |
| A23 | Malformed `default_dirs` crashes or is silently ignored                                              | Fix during import: validate                                 | fix                    |
| A25 | Doctor and show disagree on what to call a bad `requires` type                                       | Fix: one wording                                            | fix                    |
| A26 | The entry page lists install records of other types with the same name                               | Fix: filter by type                                         | fix                    |
| A27 | Installing several names reports override info for the last one only                                 | Fix: per item                                               | fix                    |
| A28 | After sending edits back, the copy still reads "edited locally"                                      | Fix: update the record after a successful local push        | fix                    |
| A29 | A dependency cycle names the wrong entry as the one requiring it                                     | Fix                                                         | fix                    |
| A30 | The https retry reuses the failed ssh attempt's folder                                               | Fix                                                         | fix                    |
| A31 | Git error summaries drop the actual ssh reason                                                       | Fix: keep it                                                | fix                    |
| A32 | Install records can lose updates under concurrent writes; catalog writes aren't atomic               | Fix                                                         | fix                    |


---

## Part 5. Not for you: I'll verify these in the first session

Listed so you know they're tracked: whether a Finder-launched app inherits the ssh agent and git
credential helpers; how the Tauri shell plugin resolves `git`/`gh` with a widened PATH; fs-plugin
speed on the largest real skill folder; a direct push from a shallow clone against a real remote;
`gh pr create` output; whether a personal-tap cask may run `xattr` after install. For skill toggles (arch §4.5): whether
`skillOverrides` in a project's `.claude/settings.local.json` replaces your global entries or merges
with them; whether a toggle reaches an already-open Claude Code session; whether
`~/.claude/commands/*.md` prompts obey `skillOverrides`; that a skill whose frontmatter `name` differs
from its folder name is matched by the frontmatter name.