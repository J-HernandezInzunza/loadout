# The Library: behavior spec for the native rebuild

Source of truth: `the-library-skill` at commit `a29e816` (branch `workstand-main`), read 2026-10-14.
Every claim cites `file:line` relative to that repo's root. Where docs and code disagree, the code
wins and the disagreement is listed in §7. This document is the test plan for the new repo: every
numbered rule is written to be turned into a test.

## 0. How to read this

**Precedence of evidence.** `library.py` > Rust (`desktop/src-tauri/src`) > Vue (`desktop/src`) >
Python tests (`tests/`) > recorded payload fixtures (`desktop/src-tauri/tests/fixtures/toolroot/payloads`)
> docs. The fixtures are older than the code in several places (they lack keys the code now emits);
§7 lists each lag. Where a JSON shape is given, it is the shape the **code** emits, with the fixture
that shows it cited alongside.

**Rule format.** `**ID** Given …, when …, then ….` followed by citations and a tag triple.

**Tags.** Every behavior carries `Tags: <origin>/<scope>/<compat>`:

| Axis | Values | Meaning |
|---|---|---|
| Origin | `cli` | implemented in `library.py` |
| | `app` | implemented only in the Rust or Vue layer |
| | `incidental` | an artifact of the CLI-wrapper architecture, not a product decision |
| Scope | `mvp` | in the v1 rebuild per the fixed decisions |
| | `later` | deferred (agent features: walkthroughs, spawning claude, MCP, secrets, setup) |
| | `drop` | not carried forward (CLI-only concerns, project scope, self-update, link) |
| | `mvp?` | not clearly covered by a decision; the one-line reason follows the tag |
| Compat | `contract` | must match byte-for-byte or semantically, or Python-CLI users of the same catalog break |
| | `free` | the new app may change it |

What counts as `contract`: anything that changes the bytes of a `library.yaml` the app writes, what a
given catalog entry means (its name, type, source URL semantics, `requires` semantics, which files it
installs), or what a teammate sees in the shared catalog repo (PR vs direct push). Device-local state
(config, receipts, clone layout, precedence, pins) is `free` because config is app-owned and receipts
are being redesigned; when a device-local convention is worth keeping anyway, the rule says so.

**UNKNOWN.** Written as `UNKNOWN:` followed by what was checked. Never a guess.

**Layer map today.**

```
SKILL.md + cookbook/*.md  ──(agent runs)──┐
                                          ▼
desktop/src (Vue) ─invoke─▶ desktop/src-tauri/src (Rust) ─spawn─▶ ./library <cmd> --json ─▶ library.py
                                                                    (bash launcher)           (the core)
```

`./library` (`library:1-68`) picks a Python ≥ 3.9 (venv first, then versioned system pythons, then
`/usr/bin/python3`), exports `LIBRARY_CWD=$PWD` before anything else (`library:10`), and execs
`library.py`. It exits 3 when no suitable Python exists (`library:53-57`); `library.py` exits 3 when
PyYAML is missing (`library.py:37-47`). Exit 3 is documented as a contract between the CLI and its
front doors ("Nothing else in this CLI exits 3", `library.py:44-46`). `Tags: incidental/drop/free`

## 1. Domain model

### 1.1 Glossary

| Term | Meaning | Defined at |
|---|---|---|
| Entry | One catalog item: `type` (skill/agent/prompt), `name`, `description`, `source`, `requires`, plus the id of the catalog it was read from | `library.py:1400-1411` |
| Section | The plural of a type, as a key under `library:` (`skills`, `agents`, `prompts`). Order is fixed: skills, agents, prompts | `library.py:71-73` |
| Catalog | A `library.yaml` file. *Local* (a path on this machine) or *remote* (a git repo + path + branch, read from a persistent clone) | `library.py:1414-1478` |
| Registry | The ordered list of catalogs this device reads, highest precedence first | `library.py:769-790` |
| Pin | A per-name override of registry precedence: `name -> catalog id` | `library.py:780-786`, `737-765` |
| Source | Where an entry's files come from: a GitHub/Bitbucket browser or raw URL to a file, or an absolute/`~` local path | `library.py:1562-1613` |
| Install dir / scope | Where an entry type installs. Two scopes: `global` (`~/.claude/...`, default) and `project` (relative, anchored to the invocation cwd) | `library.py:75-81`, `1686-1715` |
| Destination (dest) | `<install dir>/<name>` for a skill (a directory), `<install dir>/<name>.md` for agents and prompts | `library.py:2284-2288` |
| Archive | Sibling of an install dir suffixed `-disabled` (`~/.claude/skills-disabled`); where a disabled skill is parked | `library.py:1718-1735` |
| Receipt | Per-destination record of what this tool installed there | `library.py:185-287` |
| Install state | Derived per destination from disk + receipt: `installed`, `drifted`, `untracked`, `disabled`, `missing`, `not_installed` (+ `stale` in `list --check-remote`) | `library.py:1901-1927`, `3408-3422` |
| Write mode | How a catalog edit reaches its catalog: `local`, `direct`, `pr` (derived, never configured) | `library.py:1442-1451` |

### 1.2 Catalogs

A registry item becomes a `Catalog` through `_catalog_from_raw` (`library.py:718-734`):

| Field | Local | Remote | Default | Notes |
|---|---|---|---|---|
| `id` | required | required | none | Stripped string; unique across the registry (`library.py:900-907`) |
| `path` | required | must be absent | none | Absolute or `~`-prefixed (`library.py:934-938`). A directory means `<dir>/library.yaml` (`library.py:1470-1473`) |
| `repo` | must be absent | required | none | Clone URL, used verbatim for clone/pull/ls-remote |
| `yaml_path` | n/a | required | `library.yaml` via `catalog add` only (`library.py:6988`) | Relative path in the repo; no leading `/`, no `..`, no `:` (`library.py:921-925`) |
| `branch` | n/a | required | `main` via `catalog add` only (`library.py:6987`) | |
| `writable` | optional | optional | `true` (`library.py:721`) | `false` refuses every write (`library.py:1187-1188`, `3174-3175`) |
| `git_commit` | optional | n/a | `false` (`library.py:726`) | Local only: commit + push the file after each write |
| `protected` | n/a | optional | **`true` when absent** (`library.py:733`) | But `catalog add` writes `protected: false` unless `--protected` (`library.py:5928-5931`) |

Derived properties:

| Property | Rule | Citation |
|---|---|---|
| `kind` | `local` if `path` is set, else `remote` | `library.py:722-734` |
| `write_mode` | local → `local`; remote+protected → `pr`; remote+unprotected → `direct` | `library.py:1442-1451` |
| `clone_dir` | id `shared` → `<tool>/.catalog-repo`; any other remote → `<tool>/.catalogs/<id>`; local → none | `library.py:62-63`, `1453-1461` |
| `yaml_file` | remote: `clone_dir/yaml_path`; local: `path` or `path/library.yaml` if a directory | `library.py:1463-1473` |
| `root` | parent directory of `yaml_file` (the git work tree for a git-backed local catalog) | `library.py:1475-1478` |
| `catalog_key` (identity) | remote: `<repo>#<yaml_path>@<branch>`; local: resolved absolute path of `yaml_file` | `library.py:5801-5815` |
| `catalog_location` (display) | remote: `<repo> (<branch>, <yaml_path>)`; local: `yaml_file` | `library.py:5782-5786` |
| `skipped` | runtime: non-empty reason when the catalog could not be read this run | `library.py:983-1007` |

`catalog_key` exists because `id` is a renameable nickname; receipts record both (`library.py:272-277`,
`5801-5812`). `Tags: cli/mvp/free` (identity is device-local; keep the concept).

### 1.3 Registry, precedence, active set

- Registry order is precedence order, highest first; the first catalog defining a name wins
  (`library.py:776-778`, `817-828`).
- *Active* catalogs are those not skipped this run (`library.py:793-796`); *writable* = active ∧
  `writable` (`library.py:798-800`); *remotes* include skipped ones (`library.py:802-806`).
- `multi_catalog` is true when **registered** count > 1 (not active count), so per-catalog output
  does not silently collapse when one catalog is skipped (`library.py:973-980`). It gates extra
  columns in human output and the shape of some error messages.

### 1.4 Entries

Read by `iter_entries` (`library.py:1520-1534`): for each section in order skills, agents, prompts,
each list item becomes an Entry with `name = raw.get("name", "")`, `description = raw.get("description", "")`,
`source = raw.get("source", "")`, `requires = list(raw.get("requires", []) or [])`. Unknown keys in an
entry are ignored on read **and dropped on update** (§2.7, EDIT-12). `iter_catalog_entries` stamps
`catalog = <id>` (`library.py:1537-1547`).

A name is resolved by **name only**, not by type: `find_exact` returns the first entry whose `name`
equals the query exactly (case-sensitive) (`library.py:1550-1554`). Within one catalog, a skill
therefore shadows an agent or prompt of the same name (sections are read skills-first).

`requires` refs are strings `type:name` (`library.example.yaml:34`). Authoring validates `type ∈
{skill, agent, prompt}` (`library.py:4865-4866`); resolution splits on the first `:` and strips both
halves (`library.py:2117-2122`).

### 1.5 Source URL forms

Parsed by `parse_source` (`library.py:1598-1613`) after `.strip()`:

| Form | Pattern (exact regex) | `kind` | Example |
|---|---|---|---|
| Local absolute | starts with `/` | `local` | `/Users/you/skills/x/SKILL.md` |
| Local home | starts with `~` (expanded) | `local` | `~/dev/skills/x/SKILL.md` |
| GitHub blob | `^https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)$` (`library.py:1590`) | `github` | `https://github.com/org/repo/blob/main/skills/x/SKILL.md` |
| GitHub raw | `^https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.+)$` (`library.py:1591`) | `github` | `https://raw.githubusercontent.com/org/repo/main/prompts/p.md` |
| Bitbucket src | `^https://bitbucket\.org/([^/]+)/([^/]+)/src/([^/]+)/(.+)$` (`library.py:1592`) | `bitbucket` | `https://bitbucket.org/ws/repo/src/main/skills/x/SKILL.md` |
| Bitbucket raw | `^https://bitbucket\.org/([^/]+)/([^/]+)/raw/([^/]+)/(.+)$` (`library.py:1593`) | `bitbucket` | `https://bitbucket.org/ws/repo/raw/main/agents/a.md` |

Post-processing: a trailing `.git` on the repo segment is dropped (`library.py:1610-1611`); the path
loses everything from the first `?` and then the first `#` (`library.py:1612`). The branch is **one
path segment** (`[^/]+`), so branch names containing `/` cannot be expressed (§7).
Anything else raises `unrecognized source format: <source>` (`library.py:1607-1608`): relative paths,
`http://`, GitHub `/tree/` URLs, other hosts.

Resolution to fetchable files (`library.py:1573-1587`, `2384-2389`, `2320-2331`, `2399-2414`):

| Entry type | What is copied | From (remote: inside a clone of the repo at `branch`) | To |
|---|---|---|---|
| skill | the **directory containing** the referenced file (whole tree, recursively) | `dirname(file_path)` | `<skills dir>/<name>/` |
| agent | the single referenced file | `file_path` | `<agents dir>/<name>.md` |
| prompt | the single referenced file | `file_path` | `<prompts dir>/<name>.md` |

Clone URLs, tried in this order (`library.py:1581-1587`): `git@<host>:<org>/<repo>.git`, then
`https://<host>/<org>/<repo>.git`, host = `bitbucket.org` for Bitbucket, else `github.com`
(raw.githubusercontent.com sources clone from github.com).

`Tags: cli/mvp/contract` for the whole table: a catalog author relies on exactly these forms and on
"a skill installs its source file's folder".

### 1.6 Pins

`pins: {<entry name>: <catalog id>}` in config (`library.py:786`, `944-952`, `964-965`). A pin moves
the pinned catalog's copy of that one name to the front of that name's slots in the merged entry list
(`library.py:737-765`); every resolver then follows it without knowing pins exist (`library.py:817-828`).
A pin whose catalog is unregistered, skipped, or does not hold the name is **inert**: resolution falls
back to precedence and nothing fails (`library.py:744-748`, `940-943`). Rules in §2.1.

### 1.7 Write modes

| Mode | Catalog | Effect of a write | Citation |
|---|---|---|---|
| `local` | local | Edit the file in place. If `git_commit: true` and the file's directory is a git work tree: `pull --ff-only` first (best effort), then `git add`, `commit`, `push` | `library.py:3072-3080`, `3100-3106`, `3026-3050` |
| `direct` | remote, `protected: false` | Pull the persistent clone (clone if absent), edit in place, `add`, `commit`, `push origin HEAD:<branch>` | `library.py:3068-3071`, `3044` |
| `pr` | remote, `protected: true` (default) | Fresh temp clone, edit, branch `library/<op>-<name>-<YYYYmmddTHHMM>`, commit, push the branch; `gh pr create` only if `autopush: true` and host is github.com | `library.py:3109-3147`, `2889-2893`, `2914-2996` |

`autopush` (config, default `false`, `library.py:787`, `966`) never pushes to a protected branch; it
only decides whether `gh pr create` runs after the branch is pushed (`library.py:2925-2926`).

### 1.8 Install destinations

Built-in dirs (`library.py:77-81`):

| Section | `global` | `project` |
|---|---|---|
| skills | `~/.claude/skills/` | `.claude/skills/` |
| agents | `~/.claude/agents/` | `.claude/agents/` |
| prompts | `~/.claude/commands/` | `.claude/commands/` |

The effective mapping is the built-ins with the config's `default_dirs` merged per section and per
scope (`library.py:1141-1152`). A catalog's own `default_dirs` block is ignored (doctor warns,
`library.py:6262-6270`). `default_dirs` uses the list-of-single-key-mappings shape and the legacy
scope key `default` means `project` (`library.py:1496-1517`).

Path resolution (`library.py:1704-1715`): `~` is expanded; an absolute path is used as-is; a relative
path is anchored to `project_cwd()` = `--cwd` > `$LIBRARY_CWD` > process cwd (`library.py:1686-1701`,
`7039-7041`, `library:10`).

Project scope and `--dir` exist today and are documented in §3 (`use`, `uninstall`, `push --from`),
but are `drop` in v1: global installs only. `Tags: cli/drop/free`

### 1.9 Receipts (`.installs.json`)

Location `<tool>/.installs.json` (`library.py:61`). Exact on-disk schema (`library.py:185-188`,
`236-244`):

```json
{
  "version": 1,
  "installs": [
    {
      "dest": "/Users/u/.claude/skills/alpha",
      "name": "alpha",
      "type": "skill",
      "catalog": "shared",
      "catalog_key": "git@github.com:org/catalog.git#library.yaml@main",
      "scope": "global",
      "source": "https://github.com/org/repo/blob/main/skills/alpha/SKILL.md",
      "commit": "<40-hex sha of the source repo HEAD at install, or null for local sources>",
      "source_oid": "<git tree oid of the skill folder / blob oid of the file, or null>",
      "content_hash": "sha256:<hex>",
      "installed_at": "2026-08-13T19:11:06Z"
    }
  ]
}
```

- Keyed by `dest`; one receipt per destination; re-install replaces (`library.py:247-287`).
- Written sorted by `dest`, 2-space JSON indent, trailing newline, atomically under a lock (§2.12).
- Read fail-soft: missing/unreadable/malformed/`version != 1` reads as no receipts (`library.py:214-233`).
- `content_hash` algorithm (`library.py:191-211`): SHA-256 over, for each file in sorted relative-path
  order (recursive for a directory; the single name for a file), `relpath` bytes + `\0` + file bytes +
  `\0`; prefixed `sha256:`. A missing path hashes as the empty digest. Relative paths use the OS
  separator via `str(Path.relative_to)` (`library.py:2205-2207`).

Receipts are device state the rebuild may redesign (decision); the hash algorithm only matters if the
new app wants to classify Python-CLI installs (architecture §4). `Tags: cli/mvp/free`

### 1.10 Disabled state

Disable moves `<install dir>/<name>` to `<install dir>-disabled/<name>` (`library.py:1718-1735`,
`4411-4533`). It is a move, not a delete or a flag, so that (a) Claude Code stops loading it (the
archive is outside the scanned tree), (b) re-enabling needs no network, and (c) the user's content
survives a re-clone of the tool (the archive is deliberately outside `SKILL_DIR`) (`library.py:65-68`,
`1721-1730`, `4412-4418`). Disabled state is never stored; it is derived from the disk
(`library.py:1916-1923`). Skills only, global scope only (`library.py:4419-4420`, `4458-4460`).
`Tags: cli/drop/free`

**Rebuild change (decided 2026-10-28).** The app turns skills off with Claude Code's own setting,
`skillOverrides` in `~/.claude/settings.json` (`"<skill name>": "off"`; deleting the key turns it
back on), and never moves files. `~/.claude/skills-disabled/` is read only to find copies the Python
CLI parked there and offer to migrate them. Details, caveats and what this removes: architecture §4.5.
Tags: app/mvp/free

### 1.11 Install states

`dest_state(dest, receipt)` (`library.py:1904-1927`):

| State | Condition (evaluated in this order) |
|---|---|
| `disabled` | `dest` absent and `<archive>/<name>` present |
| `missing` | `dest` absent, no archive copy, receipt exists |
| `not_installed` | `dest` absent, no archive copy, no receipt |
| `untracked` | `dest` present, no receipt |
| `installed` | `dest` present, receipt's `content_hash` equals the current hash |
| `drifted` | `dest` present, hashes differ |
| `stale` | only in `list --check-remote`: `installed` and the source moved (§2.5) |

Worst-first ranking when one entry has several destinations: `not_installed < installed < disabled <
missing < untracked < drifted` (`library.py:1896-1901`, `2005-2019`).

In the rebuild, `disabled` is no longer a disk state: a copy is present at its destination and is
*off* when the effective `skillOverrides` value for its skill name is `"off"` (architecture §4.5). Tags: app/mvp/free

### 1.12 Exact schemas

#### config.local.yaml (today; to be imported once)

Validation is `Config.problems` (`library.py:864-953`), loading is `Config.from_dict`
(`library.py:955-970`).

```yaml
# exactly one of `catalogs:` (canonical) or `catalog:` (legacy) — both or neither is invalid
catalogs:                       # non-empty list, precedence order
  - id: shared                  # required, unique
    repo: git@github.com:org/agent-library.git   # remote: repo + yaml_path + branch
    yaml_path: library.yaml
    branch: main
    protected: true             # optional, default true
    writable: true              # optional, default true
  - id: personal
    path: ~/dev/my-library      # local: absolute or ~; a dir means <dir>/library.yaml
    git_commit: false           # optional, default false
    writable: true              # optional, default true
pins:                           # optional mapping name -> catalog id (non-empty strings)
  some-skill: personal
autopush: false                 # optional bool, default false
default_add_catalog: personal   # optional; write target when several are writable
default_dirs:                   # optional per-device install-dir override
  skills:
    - global: ~/.claude/skills/
    - project: .claude/skills/  # 'default:' is a legacy alias of 'project:'
  agents: [...]
  prompts: [...]
# legacy form, still read forever (normalized to one protected remote with id 'shared'):
# catalog: {repo: ..., yaml_path: ..., branch: ...}
```

Unrecognized top-level keys are preserved by the CLI's rewrites (`library.py:1061-1063`,
`5731-5736`, `6641`). `autopush`, `default_add_catalog`, `default_dirs` types are not validated by
`Config.problems` (`library.py:864-953`); a mapping-shaped `default_dirs.<section>` is silently
ignored because only list items that are mappings are read (`library.py:1512-1515`).

The CLI rewrites the file as `_CONFIG_HEADER + "\n" + yaml.safe_dump(data, sort_keys=False)`
(`library.py:1010-1022`, `1039-1040`); a fresh `init` writes the commented `_LOCAL_CONFIG_TEMPLATE`
(`library.py:6588-6610`). Config becomes app-owned in v1, so this rendering is `Tags: cli/drop/free`;
the **reading** rules above are what the one-time import needs: `Tags: cli/mvp/free`.

#### library.yaml (hard contract)

```yaml
library:                # the line must match ^library:\s*$ for writes (EDIT-03)
  skills:               # sections at 2-space indent; all three should exist (EDIT-05)
    - name: alpha       # items at 4-space indent "    - name: …"
      description: One line.
      source: https://github.com/org/repo/blob/main/skills/alpha/SKILL.md
      requires: ["skill:beta", "agent:helper"]   # optional, flow style
  agents: []            # empty section in inline [] form
  prompts: []
# optional legacy block, ignored by the tool (doctor warns):
# default_dirs: {skills: [{project: .claude/skills/}, {global: ~/.claude/skills/}], ...}
```

Reads use `yaml.safe_load`; a missing `library:` or section reads as empty (`library.py:1520-1534`).
`probe_catalog` requires a `library:` key whose value is a mapping or null (`library.py:5775-5778`).
Writes require the text shape in §2.7. `Tags: cli/mvp/contract`

#### .installs.json: see §1.9. `Tags: cli/mvp/free`

### 1.13 Device layout today

| Path | What | Citation |
|---|---|---|
| `<tool>/config.local.yaml` (+ `.lock`) | per-device config | `library.py:60`, `135` |
| `<tool>/.installs.json` (+ `.lock`) | receipts | `library.py:61` |
| `<tool>/.catalog-repo/` | clone of the catalog with id `shared` | `library.py:62` |
| `<tool>/.catalogs/<id>/` | clone of every other remote catalog | `library.py:63` |
| `<tool>/.venv/` | Python venv with PyYAML (bootstrap) | `library:31-33` |
| `~/.claude/skills/library` → `<tool>` | symlink so the `/library` skill loads (`link`) | `library.py:69`, `5694-5728` |
| `~/.claude/{skills,agents,commands}/` | install dirs (global) | `library.py:77-81` |
| `~/.claude/skills-disabled/` | archive | `library.py:68` |
| `$TMPDIR/library-*`, `library-probe-*`, `library-pr-*`, `library-push-*` | per-run temp clones | `library.py:2366`, `2473`, `2902`, `5525` |

`<tool>` is `SKILL_DIR`, the directory holding `library.py` (`library.py:59`): all device state
lives inside the tool's own git clone. That is why the desktop app must know where the clone is
(§6). `Tags: incidental/drop/free`

## 2. Core rules

### 2.1 Name resolution

**RES-01** Given catalogs `[A, B]` in registry order both defining `x` and no pin, when `x` is
resolved without `--catalog`, then A's entry is returned. Source: `library.py:817-836`, `1550-1554`.
Tags: cli/mvp/free

**RES-02** Given one catalog defining both a skill and a prompt named `x`, when `x` is resolved, then
the skill is returned (sections are read skills, agents, prompts and the first name match wins; type
is not part of the key). Source: `library.py:1520-1534`, `1550-1554`. Tags: cli/mvp/contract

**RES-03** Given a query differing only in case from an entry name, when resolved, then nothing
matches (exact, case-sensitive). Source: `library.py:1552`. Tags: cli/mvp/contract

**RES-04** Given no exact match, when a command needs one entry (`show`, `use`, `uninstall`,
`disable`, `enable`, `setup`), then it emits `{"status": "AMBIGUOUS" | "NOT_FOUND", "query", "candidates":
[{type, name, description, catalog}]}` and exits 2; `AMBIGUOUS` when `fuzzy_candidates` is non-empty.
Candidates = entries whose lower-cased name **or** description contains the lower-cased query as a
substring. Source: `library.py:1557-1559`, `3554-3571`, `4008-4026`, `4354-4372`, `4430-4450`, `4551-4571`,
`4172-4189`. Tags: cli/mvp/free

**RES-05** Given a multi-name request (`use a b c`) where `c` does not resolve, when run, then nothing
is installed/deleted/moved: every name is resolved before any effect. Source: `library.py:4005-4027`,
`4350-4373`, `4427-4450`, `4551-4571`. Tags: cli/mvp/free

**RES-06** Given `--catalog B`, when resolving, then only B's entries are searched (pins and precedence
ignored); given an unknown or skipped id, then the command dies with `unknown catalog '<id>'
(available: <active ids or none>)`, exit 1 — never a silent fallback. — `library.py:1155-1173`,
`808-814`. Tags: cli/mvp/free

**RES-07** Given `x` in A and B with A first, when listing, then B's record has `overridden_by: "A"`,
`installed: false`, `scopes: []`, `state: "not_installed"`, `receipt: null`, `locations: []` (the
losing copy never claims the shared destination). Source: `library.py:3399-3407`, `3436`. Tags: cli/mvp/free

**RES-08** Given `x` in A and B, when `show x --catalog B` runs, then the `entry` record reports B's
copy but with the destination's real install fields (`installed`, `scopes`, `state`, `receipt`,
`has_setup`, `locations`) re-derived as if B won, and `copies` lists every catalog holding `x` with
`wins` (what a plain `use` installs), `subject` (the copy this report is about), `pinned`,
`overrides`, `overridden_by`. Source: `library.py:3573-3606`. Tags: cli/mvp/free

**RES-09** Given `x` in A and B, when `use x --catalog B` runs, then B's copy is installed and the
payload carries `overrides: []`, `overridden_by: "A"` relative to B (not to the winner). Source: `library.py:1231-1250`, `4121-4126`. Tags: cli/mvp/free

**RES-10** Given pin `x: B` and registry `[A, B]` both holding `x`, when resolving `x`, then B wins;
other names keep their positions (only the slots `x` occupies are rewritten). Source: `library.py:737-765`. Tags: cli/mvp/free

**RES-11** Given pin `x: C` where C is unregistered, skipped this run, or does not define `x`, when
resolving `x`, then precedence applies and no command fails. Source: `library.py:744-748`, `760-762`,
`940-943`. Tags: cli/mvp/free

**RES-12** Given pin `x: B` that wins, when listing, then B's record has `pinned: true`, and A's has
`overridden_by: "B"`. Source: `library.py:3439`, `3364-3373`. Tags: cli/mvp/free

**RES-13** Pin refusals (`pin <name> <catalog>`): no catalog arg → `which catalog should '<name>'
resolve from?` exit 1; catalog not active → `unknown catalog '<id>' (available: …)`; no catalog holds
the name → `no catalog defines '<name>' — nothing to pin`; the catalog does not hold the name →
`'<cat>' does not define '<name>' (defined in: …)`. All before any write. Source: `library.py:3873-3888`.
Tags: cli/mvp/free

**RES-14** Given `pin x A` where A is the only holder, when written, then the pin is kept and the
result reports `only_holder: true` ("inert until another catalog defines it"). Source: `library.py:3913-3916`, `3937-3939`. Tags: cli/mvp/free

**RES-15** Given `pin x B` where copies of `x` from another catalog are installed, then
`switch_assessment` reports per destination `stale: [{dest, scope, state, from}]` (archive path for a
disabled copy), `blockers` (drifted copy, untracked copy, non-global scope copy, any `requires` of B's
copy not resolving in B), `unresolved_requires`, `new_dependencies` (B-closure entries currently
`not_installed`), `dependents` (installed entries in the old catalog that require `x`, direct or
transitive), `switchable = stale non-empty`, `simple = switchable ∧ no blockers`. Source: `library.py:3744-3820`. Tags: cli/mvp/free

**RES-16** Given `pin x B` (human mode) with `simple` true and no `--no-install`, then the CLI
immediately runs `use x` (global, `--no-pull`) to reconcile; with blockers, `--no-install`, or
`--json`, nothing is installed. `--dry-run` computes the same assessment without writing. Source: `library.py:3893-3904`, `3922-3962`. Tags: cli/mvp/free

**RES-17** Given `unpin x` when `x` is not pinned, then exit 1 `'x' is not pinned (pinned: …|none)`;
otherwise the pin is removed and an empty `pins:` key is dropped entirely; installed copies are not
touched. Source: `library.py:3965-3995`. Tags: cli/mvp/free

**RES-18** Every name→winner map is keyed by name only (`winning_catalogs`). Source: `library.py:3364-3373`.
Tags: cli/mvp/free

### 2.2 Dependencies

**DEP-01** Given entry `P` with `requires: [r1, r2]`, when its install order is computed, then it is a
depth-first post-order over refs in list order: each dependency's own closure first, then the
dependency, …, `P` last; each `(type, name)` appears once. Source: `library.py:2088-2133`. Tags: cli/mvp/contract

**DEP-02** Given a ref, when resolved, then it is split on the first `:`, both halves stripped, and
looked up by `(type, name)` **only in the entry's own catalog** (`cfg.entries_of(entry.catalog)`),
never the merged list; a ref naming an entry that exists only in another catalog dangles. Source: `library.py:2121-2122`, `4032-4035`, `4050`, `3608-3612`, `4755-4758`. Tags: cli/mvp/contract

**DEP-03** Given a ref with no `:`, then it is skipped with warning `malformed dependency ref '<ref>' on
<type>:<name>` and recorded `{ref, required_by, reason: "malformed"}`. — `library.py:2117-2120`.
Tags: cli/mvp/free

**DEP-04** Given a ref to a `(type, name)` not in the catalog (including an unknown type), then it is
skipped with warning `dependency <ref> not found in catalog (required by <name>)` and recorded with
reason `not_found`; the install proceeds without it. Source: `library.py:2123-2126`. Tags: cli/mvp/contract

**DEP-05** Given a cycle `a → b → a`, when resolving from `a`, then re-entering `a` warns `dependency
cycle detected at <type>:<name>; skipping re-entry`, records `{ref: "<type>:<name>", required_by:
<name of the re-entered node>, reason: "cycle"}`, and the walk terminates with each node once. (Note:
`required_by` is the re-entered node itself, not its parent; §7.) Source: `library.py:2110-2114`.
Tags: cli/mvp/free

**DEP-06** Given `use a b` where both require `c`, then `c` is installed once (closures merged and
de-duplicated by `(type, name)` in request order). Source: `library.py:4036-4054`. Tags: cli/mvp/free

**DEP-07** Given a target whose destination reads `disabled`, then its dependencies are **not**
installed; the entry alone is refreshed in the archive. A dependency that is itself disabled is
refreshed in its archive rather than re-activated. Source: `library.py:4039-4059`. Tags: cli/drop/free
(rebuild: an off skill stays in place, so its dependencies install normally; architecture §4.5)

**DEP-08** Dependents (`show`): entries in the target's own catalog whose closure reaches the target,
breadth-first; each `(entry, direct)`; sorted direct first, then type, then name; malformed refs
skipped silently. Source: `library.py:2136-2188`, `3614-3618`. Tags: cli/mvp/free

**DEP-09** `remove` warns `removing a dependency of: <type:name, …>` for entries **in the destination
catalog** whose `requires` contains the exact string `<type>:<name>` (direct only, no stripping) and
reports them as `dependents`. Source: `library.py:5220-5225`, `5250`, `5273`. Tags: cli/mvp/free

**DEP-10** `add` warns (does not fail) `required dependency <ref> (for <name>) is not in the catalog
yet` when a ref is neither in the destination catalog nor elsewhere in the same batch; `update` warns
`required dependency <ref> is not in the catalog yet` against the freshly read text. Source: `library.py:5121-5128`, `5387-5393`. Tags: cli/mvp/free

**DEP-11** Authoring refs must be `type:name` with type in `{skill, agent, prompt}`, else die
`invalid requires ref '<r>' (expected type:name)`; empty items in the comma list are skipped. Source: `library.py:4849-4868`. Tags: cli/mvp/contract

### 2.3 Remote catalogs

**RCAT-01** Given a remote catalog with id `shared`, its persistent clone is `<tool>/.catalog-repo`;
any other id clones to `<tool>/.catalogs/<id>`. Source: `library.py:1453-1461`. Tags: cli/mvp/free

**RCAT-02** Given a remote catalog whose clone does not exist, when config loads, then it is
`skipped` with `not cloned yet at <clone_dir>` (loading never clones). Source: `library.py:983-993`.
Tags: cli/mvp/free

**RCAT-03** Given any read or write command except `catalog list`, `unpin`, `suggest-source`, `init`,
`link`, `self-update` and `catalog init/remove/migrate` (`catalog add --repo` clones or pulls only the
catalog being added, via `probe_catalog`, `library.py:5764-5779`), when run without `--no-pull`, then every
remote catalog is refreshed first: absent clone → `git clone --depth 1 --single-branch --branch
<branch> <repo> <clone_dir>`; present → `git -C <clone_dir> pull --ff-only`; then every catalog file
is re-read. Source: `library.py:1111-1121`, `2585-2635`. Commands calling `refresh_catalogs`: list 3445,
search 3505, show 3548, pin 3855, use 4000, setup 4167, uninstall 4346, disable 4423, enable 4547,
sync 4677, add 5081, remove 5198, update 5335, push 5447; doctor pulls via `pull_all` 6450.
Tags: cli/mvp/free

**RCAT-04** Given a pull failure (offline, auth, diverged history), then the command warns `could not
pull catalog repo (<summary>); using cached copy` and continues on the cached clone. Source: `library.py:2616-2623`. Tags: cli/mvp/free

**RCAT-05** Given a **clone** failure for any registered remote catalog during refresh, then the whole
command dies (exit 1) with `could not clone catalog repo: <summary>` + `check your --repo URL and
auth, then re-run library init`. This happens even if other catalogs could serve the request (§7: likely
accidental). Source: `library.py:2599-2614`, `2629-2635`. Tags: cli/mvp/free

**RCAT-06** Given `--no-pull`, then no clone or pull happens; an uncloned remote stays skipped. Source: `library.py:1117-1118`. Tags: cli/mvp/free

**RCAT-07** Staleness: `catalog_behind` = `git -C <clone> rev-list --count HEAD..origin/<branch>`
(0 on any failure or for local catalogs). `list` and `sync` warn, per remote catalog with a non-zero
count: `warning: catalog '<id>' is <n> commit(s) behind origin/<branch> (<pull failed: <err> | catalog
was not refreshed>); <output may be stale | syncing against stale catalog metadata>` (the label is
just `catalog` when one catalog is registered). Doctor reports the same as a warning. The count reads
the last-fetched `origin/<branch>`, so when a pull fails before fetching (offline) it reports 0 even
though upstream moved: the staleness warning goes quiet exactly when it matters (git-net reader,
observed with `file://` repos). Source: `library.py:2638-2657`, `1358-1369`, `3446`, `4678`, `6453-6460`. Tags: cli/mvp/free

**RCAT-08** Given multiple catalogs and one unreadable, then it is skipped with a reason and the
others still serve (warning `catalog '<id>' skipped: <reason>` only when multi); given a single
catalog unreadable, then commands needing entries die with `catalog not found at <path>` or the skip
reason; given several all unreadable → `no readable catalog: <id> (<reason>); …`. Source: `library.py:1098-1108`, `1124-1138`. Tags: cli/mvp/free

**RCAT-09** `catalog list` never touches the network; it reports each catalog's skip reason. Source: `library.py:5818-5858`. Tags: cli/mvp/free

**RCAT-10** Conflicts: the CLI never merges or rebases a persistent clone. A direct-mode write
commits into the clone; if its push fails the clone keeps a local commit, and later `pull --ff-only`
can fail forever once upstream moves (each read then warns and uses the cached copy). No code path
repairs this. Source: `library.py:3044-3050`, `2616-2623`; UNKNOWN: whether any test covers a diverged
persistent clone; checked `library.py` for `reset`/`rebase`/`fetch` calls (none outside
`doctor`'s `fetch --dry-run` of the tool clone, `library.py:6440-6443`). Tags: cli/mvp/free

### 2.4 Source fetching

**FETCH-01** URL parsing per §1.5 table; `parse_source` raises `unrecognized source format: <source>`
for anything else. Source: `library.py:1598-1613`. Tags: cli/mvp/contract

**FETCH-02** Given a remote source, clone URLs are tried in order ssh (`git@<host>:<org>/<repo>.git`)
then https (`https://<host>/<org>/<repo>.git`); the first `git clone --depth 1 --branch <branch> <url>
<tmp>/repo` that exits 0 wins; on total failure the temp root is removed and `LibraryError("clone
failed for <org>/<repo>: <last error summary>")` is raised. — `library.py:1581-1587`, `2355-2381`.
Tags: cli/mvp/free

**FETCH-03** Every git subprocess runs with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=<path of true>` and,
unless already set by the user, `GIT_SSH_COMMAND="ssh -oBatchMode=yes"`, so a missing credential fails
fast instead of prompting (which is what makes the ssh→https fallback work); configured credential
helpers still work. Side effects: the env var outranks a gitconfig `core.sshCommand`, and
`BatchMode=yes` refuses unknown host keys. Source: `library.py:49-57`. Tags: cli/mvp/free

**FETCH-04** Per-run clone cache: within one `use` or `sync` run, one checkout per key
`<kind>:<org>/<repo>@<branch>`, shared by every entry and dependency from that repo+branch; all
cached roots are deleted when the run ends; an uncached clone is deleted right after its single copy. Source: `library.py:2334-2381`, `2399-2418`, `4100`, `4724`. Tags: cli/mvp/free

**FETCH-05** Given a remote source, when fetched, then `<clone>/<file_path>` must exist, else
`LibraryError("referenced file missing in repo: <file_path>")`; `commit = git rev-parse HEAD`;
`source_oid = git rev-parse HEAD:<dirname(file_path)>` for a skill or `HEAD:<file_path>` otherwise. Source: `library.py:2399-2414`, `2384-2396`. Tags: cli/mvp/free

**FETCH-06** Given a skill, then the **directory containing** the source file is copied recursively to
`<skills dir>/<name>`, replacing any existing directory wholesale (`rmtree` then `copytree`, symlinks
followed); given an agent/prompt, then the single file is copied to `<dir>/<name>.md` (renamed to the
entry name, `copy2` keeps mode and mtime). Source: `library.py:2268-2281`, `2284-2288`, `2412-2414`,
`2326-2331`. Tags: cli/mvp/contract

**FETCH-07** Given a local source (`/…` or `~…`), then the path must exist (`local source not found:
<path>`), the same skill-folder/single-file rule applies, and there is no commit or oid (both null in
the receipt). Source: `library.py:2320-2331`, `2559-2568`. Tags: cli/mvp/contract

**FETCH-08** Given source and destination that overlap (equal, or either inside the other) after
`resolve()`, then the copy is refused with `refusing to install <dest> from <origin>: the source is the
destination.` before anything is deleted. — `library.py:2291-2317`, `2328`. Tags: cli/mvp/free

**FETCH-09** Temp dirs: `tempfile.mkdtemp(prefix=…)` in the system temp dir: `library-` (fetch),
`library-probe-` (probe), `library-pr-` (PR write), `library-push-` (push); each is removed in a
`finally`/context exit; a killed process leaks them. Source: `library.py:2366`, `2473`, `2902-2911`,
`5525`, `5620-5622`. Tags: cli/mvp/free

**FETCH-10** Given a skill whose source file sits at the repo root (e.g. `…/blob/main/SKILL.md`), then
the copied directory is the clone root itself, `.git` included (no exclusion exists in `_copy_dir`). Source: `library.py:2268-2274`, `2413`. UNKNOWN: whether any catalog relies on this; no test found by
searching `tests/test_library.py` for `.git` exclusion in installs. (§7) Tags: cli/mvp?/contract (mvp? because copying `.git` into `~/.claude/skills` looks
accidental; decide whether to preserve).

**FETCH-11** Given a skill source that is itself a directory path (not a file), then the copied
folder is that directory's **parent** (`ref.parent`), not the directory. Source: `library.py:2327`,
`2413`. (§7) Tags: cli/mvp/contract

**FETCH-12** Post-copy verification: `verified = main_file_for(entry, dest).exists()`, where
`main_file_for` returns `dest/SKILL.md`, else `dest/AGENT.md`, else `dest` itself for a skill, and
`dest` for agents/prompts. Because the fallback is `dest`, which the copy just created, `verified` is
true after every successful copy (§7). `use` exits 1 if any result is unverified. Source: `library.py:2571-2578`, `3301-3305`, `4154`. Tags: cli/mvp/free

### 2.5 Update detection

**UPD-01** `remote_head(src, cache)`: one `git ls-remote <url> <branch>` per key
`<kind>:<org>/<repo>@<branch>` per run, ssh URL then https; the first exit-0 with non-empty stdout
gives the sha (first whitespace token); otherwise `None` (= "don't know"). Memoized including `None`. Source: `library.py:2421-2440`. Tags: cli/mvp/free

**UPD-02** `remote_oid(src, entry, probes)`: once per key per run, `git clone --depth 1
--filter=blob:none --no-checkout --branch <branch> <url> <tmp>/repo` (ssh then https), `commit = git
rev-parse HEAD`; failure memoized as `None`. Then `oid = git rev-parse <commit>:<source path>`; `None`
when the path no longer exists at the tip. A server ignoring the filter yields a plain shallow clone
(slower, same answer). Source: `library.py:2443-2493`. Tags: cli/mvp/free

**UPD-03** `content_unmoved(src, entry, receipt, probes)` returns the tip commit only when: probes are
available, the receipt has a `source_oid`, `receipt.source == entry.source` (a repointed source never
borrows an oid), and the probed oid equals the receipt's. Otherwise `None`. Source: `library.py:2496-2511`.
Tags: cli/mvp/free

**UPD-04** `source_unchanged` (sync's skip test) is true only when **both** ends are unchanged: the
destination reads `installed` (receipt present, hash matches) **and** the source is unchanged: local
skill → `content_hash(src folder) == content_hash(dest)`; local file → byte-equal; remote → `head ==
receipt.commit`, or head moved but `content_unmoved` proves the folder/file oid is the same. Any
unknown (no receipt, drifted, untracked, unparseable source, unreachable remote, missing oid) → false
→ refetch. Source: `library.py:2514-2556`. Tags: cli/mvp/free

**UPD-05** Given a moved head with unmoved content, when `source_unchanged` returns true, then the
receipt's `commit` is advanced to the probed tip and saved, so the next run is back on the one
`ls-remote` path. Source: `library.py:2525-2527`, `2550-2556`. Tags: cli/mvp/free

**UPD-06** `list --check-remote`: an entry reads `stale` only when it is `installed`, its receipt has a
`commit`, its source is remote, the head is known and differs from the receipt, **and**
`content_unmoved` cannot prove the content unchanged. Unknown head → stays `installed`. Local
sources never read `stale`. `list --check-remote` does not advance receipts. Without the flag, `list`
makes no source-network calls. Source: `library.py:3408-3422`, `3452-3456`. Tags: cli/mvp/free

**UPD-07** `search` and `show` never compute staleness (they pass no `heads`). Source: `library.py:3510-3512`, `3577`. Tags: cli/mvp/free

**UPD-08** Vocabulary. *changed* = the item will be refetched (`up_to_date: false`); *unmoved* =
content oid unchanged although the branch head moved; *up to date* = `source_unchanged` true;
*stale* = installed copy behind its source (list only). `sync --force` refetches everything. Source: `library.py:4735-4746`, `4761-4782`, `6907-6908`. Tags: cli/mvp/free

### 2.6 Writes: destination and mode

**WRITE-01** Given `--catalog <id>` on a write, then the target is that active catalog; unknown or
skipped → `unknown catalog '<id>' (available: …)`; `writable: false` → `catalog '<id>' is read-only
(writable: false)`; both exit 1. — `library.py:1185-1189`, `5085-5089`. Tags: cli/mvp/free

**WRITE-02** Given no `--catalog` on `add`, then: no writable catalog → `no writable catalog is
configured; nothing can be written` (exit 1); exactly one writable → it; else the writable catalog
whose id equals `default_add_catalog` (a stale default is ignored, never an error); else
`AMBIGUOUS_CATALOG`. Source: `library.py:1176-1199`. Tags: cli/mvp/free

**WRITE-03** `AMBIGUOUS_CATALOG` is not a failure: JSON `{"status": "AMBIGUOUS_CATALOG", "catalogs":
[<writable ids>]}`, exit 2; human output names the choices and `--catalog`/`default_add_catalog`. Source: `library.py:105-115`, `1202-1217`; fixture `payloads/ambiguous.json`. Tags: cli/mvp/free

**WRITE-04** Given `update`/`remove` of a name held by more than one catalog and no `--catalog`, then
`AMBIGUOUS_CATALOG` with the holders (resolution order), exit 2, before any write; with `--catalog`,
the named catalog's copy is edited. The destination is always the catalog the entry resolved from;
`default_add_catalog` has no say. Source: `library.py:1220-1228`, `5205-5218`, `5342-5356`.
Tags: cli/mvp/free

**WRITE-05** Given a local-path source and a **remote** destination catalog, when `add` or `update
--set-source` runs without `--allow-local`, then it dies: multi-catalog message names the catalog and
suggests a local catalog; single-catalog message is `local-path sources don't resolve for teammates
pulling the shared catalog.` …; both append `This file is in a git repo — did you mean: <url>` when a
GitHub/Bitbucket browser URL can be derived from the path's git origin. A **local** destination
accepts local paths with no flag. Source: `library.py:4871-4893`, `4970-4974`, `5358-5365`.
Tags: cli/mvp/contract (protects teammates of a remote catalog)

**WRITE-06** Given a local source inside a configured **global** install dir, then `add`/`update
--set-source` die (not overridable): the entry would overwrite its own source on install; inside a
**project** install dir, then only a warning. Source: `library.py:1755-1782`, `4896-4936`. Tags: cli/mvp/free

**WRITE-07** Given a write to a `pr`-mode catalog, then (in order): temp clone `git clone
--single-branch --branch <branch> <repo> <tmp>/repo` (die `failed to clone <repo> for write op: …` on
failure); edit + verify on the clone's file; write; `git checkout -b <branch name>`; `git add
<yaml_path>`; `git commit -m <msg>`; dry run → return `git show HEAD` as `diff` and stop (nothing
pushed); else `git push -u origin <branch name>`; build the compare URL; `autopush` decides `gh pr
create`. Temp dir always removed. — `library.py:3109-3147`, `2896-2911`, `2914-2996`. Tags: cli/mvp/contract
(team process: protected catalogs only change through PRs)

**WRITE-08** PR branch name = `library/<op>-<name with [^a-zA-Z0-9_-] → '-'>-<local time %Y%m%dT%H%M>`;
ops: `add`, `add-batch` (hint `<n>-entries`), `remove`, `update`; `push` uses `update`. Source: `library.py:2889-2893`, `5131-5143`, `5240`, `5414`, `5519`. Tags: cli/mvp/free

**WRITE-09** Push rejection: if `git push` stderr (lower-cased) contains any of `denied`, `permission`,
`403`, `forbidden`, `not authorized`, `protected branch`, `remote rejected`, `remote: error`, die
`push rejected — you lack write access to <repo>.` + advice; any other failure → `push failed:
<summary>`. — `library.py:2931-2947`. Tags: cli/mvp/free

**WRITE-10** Compare URL after a pushed branch: GitHub
`https://github.com/<owner>/<repo>/compare/<base>...<branch>?expand=1`; Bitbucket
`https://bitbucket.org/<owner>/<repo>/pull-requests/new?source=<branch>&dest=<base>`; other hosts →
`null`. Owner/repo parsed from the clone URL by `^(?:git@|ssh://git@|https://)([^/:]+)[:/]+([^/]+)/(.+?)(?:\.git)?/?$`. Source: `library.py:1595`, `1616-1621`, `2949-2960`. Tags: cli/mvp/free

**WRITE-11** `autopush: false` → result `{method: "manual", branch, compare_url}`. `autopush: true`
and github.com → `gh pr create --repo <owner>/<repo> --base <base> --head <branch> --title <title>
--body <body>`; success → `{method: "gh", pr_url: <stdout stripped>, branch}`; non-zero → die
`autopush is on but gh pr create failed: <last stderr line>` + the compare URL; `gh` missing → die
`autopush is on but the gh CLI is not installed …`. Bitbucket with autopush → warn `autopush has no CLI
path for Bitbucket; open the PR via the printed URL` and return manual. The branch is pushed in every
case. Source: `library.py:2962-2996`. Tags: cli/mvp/free

**WRITE-12** PR/commit copy: add (one) commit `library: added <type> <name>`, title `library: add
<type> <name>`, body `Adds \`<name>\` (<type>) to the catalog.\n\nSource: <source>`; add (batch) commit
`library: add <n> entries (<names>)`, title `library: add <n> entries`, body list of `` - `<name>`
(<type>) — <source> ``; remove commit `library: removed <type> <name>`, title `library: remove <type>
<name>`, body ``Removes `<name>` (<type>) from the catalog.``; update commit and title `library:
updated <type> <name>`, body ``Updates `<name>` (<type>) in the catalog.``. Source: `library.py:5131-5143`, `5237-5239`, `5410-5414`. Tags: cli/mvp/free

**WRITE-13** `direct` mode: `pull_catalog` (clone on demand, ff-only pull, warn on failure), edit the
clone's file in place, then `git add <yaml_path>`, `git commit -m <msg>`, `git push origin
HEAD:<branch>`. A commit or push failure is a **warning**, not an error: the file is already written,
and the result reports `committed`/`pushed` false. Source: `library.py:3053-3106`, `3026-3050`.
Tags: cli/mvp/free

**WRITE-14** `local` mode: write the file in place. With `git_commit: true` and the catalog directory
inside a git work tree: best-effort `git pull --ff-only` before writing (warn `could not pull catalog
'<id>' before writing (…); writing against the local copy`), then add/commit/`git push` (plain, to
the upstream). `git_commit: true` outside a work tree → warn and just write. Source: `library.py:3072-3080`,
`3011-3023`, `3044`. Tags: cli/mvp/free

**WRITE-15** Every write recomputes the edit against the exact bytes it will write (`update` reads the
entry from the text handed to `edit`, so a stale registry copy can never clobber an upstream change);
the no-op test compares fields (description, source, requires), not bytes; a no-op returns
`changed: false` and writes nothing. Source: `library.py:3086-3089`, `5367-5400`. Tags: cli/mvp/free

**WRITE-16** Every write re-parses the new text with `yaml.safe_load` and verifies the entry is
present (add/update) or absent (remove) **before** writing; a failed verification dies `internal
error: …; aborting`. — `library.py:3090`, `3129`, `5150-5155`, `5227-5231`, `5402-5406`.
Tags: cli/mvp/contract

**WRITE-17** Dry run: local/direct → unified diff `--- a/<file> +++ b/<file>` (`difflib`, file name
relative: `yaml_path` for direct, basename for local), nothing written, but direct mode still pulls
first; pr → the temp clone is created, committed, and `git show HEAD` returned, nothing pushed. Source: `library.py:3092-3098`, `3135-3140`. Tags: cli/mvp/free

**WRITE-18** Write result keys: always `mode`, `catalog`; local/direct add `path`, `committed`,
`pushed`, `branch` (`null` for local, the catalog branch for direct); pr adds `method`, `branch`, and
`pr_url` or `compare_url`; dry runs add `diff` (and `path` for in-place). `write_result_keys` strips
`diff`, `changed`, `dry_run` before merging into a command payload. Source: `library.py:3171-3197`.
Tags: cli/mvp/free

### 2.7 Catalog file editing (hard contract)

The edit functions are pure text transforms over `text.split("\n")` rejoined with `"\n"`. Everything
outside the edited block is preserved byte-for-byte. The new core must reproduce them exactly; quoted
verbatim here (`library.py:2673-2826`):

```python
def _yaml_inline(value: str) -> str:
    """Encode a single value as YAML would on one line (adds quoting only if needed)."""
    s = yaml.safe_dump({"v": value}, default_flow_style=False, allow_unicode=True, width=10**9).rstrip("\n")
    if "\n" in s:
        raise LibraryError("multiline values are not supported in catalog entries; keep it on one line")
    return s.split(": ", 1)[1] if ": " in s else s.split(":", 1)[1].lstrip()


def render_entry(entry: Entry) -> list[str]:
    """Render an entry as catalog text lines (4-space item, 6-space props, flow requires)."""
    out = [
        f"    - name: {_yaml_inline(entry.name)}",
        f"      description: {_yaml_inline(entry.description)}",
        f"      source: {_yaml_inline(entry.source)}",
    ]
    if entry.requires:
        reqs = ", ".join(f'"{r}"' for r in entry.requires)
        out.append(f"      requires: [{reqs}]")
    return out


_ITEM_NAME_RE = re.compile(r"^    - name:\s*(.+?)\s*$")


def _locate_section(lines: list[str], section: str) -> tuple[int, str, int]:
    """Return (section_line_idx, inline_value, section_end_exclusive) for a library section."""
    lib_idx = next((i for i, l in enumerate(lines) if re.match(r"^library:\s*$", l)), None)
    if lib_idx is None:
        raise LibraryError("no 'library:' key in catalog")

    sec_re = re.compile(rf"^  {section}:\s*(.*)$")
    sec_idx = sec_inline = None
    for i in range(lib_idx + 1, len(lines)):
        if re.match(r"^\S", lines[i]):  # left the library block
            break
        m = sec_re.match(lines[i])
        if m:
            sec_idx, sec_inline = i, m.group(1).strip()
            break
    if sec_idx is None:
        raise LibraryError(f"section '{section}' not found under library")

    # Section runs until the next 2-space sibling key or a top-level key or EOF.
    sec_end = len(lines)
    for i in range(sec_idx + 1, len(lines)):
        l = lines[i]
        if l.strip() == "":
            continue
        if re.match(r"^\S", l) or (re.match(r"^  \S", l) and not l.startswith("    ")):
            sec_end = i
            break
    return sec_idx, sec_inline, sec_end


def _item_starts(lines: list[str], sec_idx: int, sec_end: int) -> list[int]:
    """Line indices where each entry begins (the `- ` marker) within a section."""
    return [i for i in range(sec_idx + 1, sec_end) if lines[i].startswith("    - ")]


def splice_entry(text: str, entry: Entry) -> str:
    section = entry.section
    lines = text.split("\n")
    sec_idx, sec_inline, sec_end = _locate_section(lines, section)

    items = [(m.group(1).strip().strip('"\''), i)
             for i in _item_starts(lines, sec_idx, sec_end)
             if (m := _ITEM_NAME_RE.match(lines[i]))]
    if any(nm == entry.name for nm, _ in items):
        raise LibraryError(f"'{entry.name}' already exists in {section}")

    block = render_entry(entry)

    if sec_inline == "[]":  # empty inline section -> convert to block
        lines[sec_idx] = f"  {section}:"
        new = lines[:sec_idx + 1] + block + lines[sec_idx + 1:]
        return "\n".join(new)

    insert_at = sec_end
    for nm, idx in items:
        if entry.name.lower() < nm.lower():
            insert_at = idx
            break
    if insert_at == sec_end:  # appending: back up over trailing blank lines
        while insert_at - 1 > sec_idx and lines[insert_at - 1].strip() == "":
            insert_at -= 1

    new = lines[:insert_at] + block + lines[insert_at:]
    return "\n".join(new)


def remove_entry(text: str, entry_type: str, name: str) -> str:
    section = PLURAL[entry_type]
    lines = text.split("\n")
    sec_idx, _, sec_end = _locate_section(lines, section)
    starts = _item_starts(lines, sec_idx, sec_end)

    target = None
    for si in starts:
        m = _ITEM_NAME_RE.match(lines[si])
        if m and m.group(1).strip().strip('"\'') == name:
            target = si
            break
    if target is None:
        raise LibraryError(f"'{name}' not found in {section}")

    later = [s for s in starts if s > target]
    block_end = later[0] if later else sec_end
    del lines[target:block_end]

    # If the section is now empty, collapse it back to the inline `[]` style.
    sec_idx, _, sec_end = _locate_section(lines, section)
    if not _item_starts(lines, sec_idx, sec_end):
        del lines[sec_idx + 1:sec_end]
        lines[sec_idx] = f"  {section}: []"
    return "\n".join(lines)


def replace_entry(text: str, entry_type: str, name: str, new_entry: Entry) -> str:
    section = PLURAL[entry_type]
    lines = text.split("\n")
    sec_idx, _, sec_end = _locate_section(lines, section)
    starts = _item_starts(lines, sec_idx, sec_end)

    target = None
    for si in starts:
        m = _ITEM_NAME_RE.match(lines[si])
        if m and m.group(1).strip().strip('"\'') == name:
            target = si
            break
    if target is None:
        raise LibraryError(f"'{name}' not found in {section}")

    later = [s for s in starts if s > target]
    block_end = later[0] if later else sec_end
    lines[target:block_end] = render_entry(new_entry)
    return "\n".join(lines)
```

Rules (each was confirmed by running the functions above against PyYAML 6.0.3 from the repo's
`.venv`; the probe scripts are reproduced in Appendix D as golden cases):

**EDIT-01** Rendering: exactly three lines `    - name: <v>`, `      description: <v>`, `      source:
<v>` (4/6-space indent, this key order), plus `      requires: ["a", "b"]` only when `requires` is
non-empty. Refs are wrapped in `"` with **no escaping**. Source: `library.py:2681-2691`. Tags: cli/mvp/contract

**EDIT-02** Scalar quoting is whatever PyYAML's `safe_dump` emits for `{"v": value}` with
`default_flow_style=False, allow_unicode=True, width=10**9`, minus the `v: ` prefix: plain when
PyYAML allows plain, else single-quoted (`'` doubled), else double-quoted. Observed:
`a: b`→`'a: b'`, `yes`/`No`/`on`/`null`/`~`→quoted, `123`/`1.5`/`.5`/`+1`/`0x1F`/`0b101`/`1_000`/`1:20`/
`2001-12-14`/`.inf`/`<<`/`=`→quoted, `1e3`/`NaN`/`0o17`/`y`→**plain**, `''` for empty,
`' lead'`/`'trail '` quoted, `#hash`/`x #y`→quoted, `it's`→plain, `'q'`→`'''q'''`, `"dq"`→`'"dq"'`,
`- dash`/`[x]`/`{x}`/`@at`/`` `bt ``/`%pct`/`!bang`/`&amp`/`*star`/`|pipe`/`>gt`/`?`/`-`/`:`→quoted,
`?q`/`a:b`/`é unicode`/`https://x/y?z#w`→plain, a tab → `"tab\there"`. These are PyYAML's YAML 1.1
implicit resolvers plus its emitter's scalar analysis; a TS port must replicate both, not use another
library's quoting. Source: `library.py:2673-2678`. Tags: cli/mvp/contract

**EDIT-03** A value containing a newline is refused: `LibraryError("multiline values are not supported
in catalog entries; keep it on one line")`. — `library.py:2676-2677`. Tags: cli/mvp/contract

**EDIT-04** The `library:` line must match `^library:\s*$` (a trailing comment on it → `no 'library:'
key in catalog`). — `library.py:2699-2701`. Tags: cli/mvp/contract

**EDIT-05** A section is found only as a line `^  <section>:\s*(.*)$` (exactly two spaces) inside the
`library:` block; a missing section is **not created**: `section '<section>' not found under library`. Source: `library.py:2703-2713`. Tags: cli/mvp/contract

**EDIT-06** A section ends at the first non-blank line that starts at column 0 or with exactly two
spaces then a non-space (so a 2-space-indented comment or a column-0 comment ends it); blank lines are
skipped while searching; otherwise EOF. Source: `library.py:2715-2724`. Tags: cli/mvp/contract

**EDIT-07** Items are lines starting with exactly four spaces then `- `; an item's block runs to the
next item start or the section end. Names are read from `^    - name:\s*(.+?)\s*$` with surrounding
`"`/`'` stripped. Items in any other layout (e.g. `  - name:` at 2 spaces, or `- name` not first in
the item) are invisible to duplicate detection, ordering, removal and replacement. Source: `library.py:2694`, `2727-2729`, `2742-2744`. Tags: cli/mvp/contract

**EDIT-08** Insert: duplicate name (exact) in the section → `'<name>' already exists in <section>`;
section header `  <section>: []` (inline value exactly `[]`) → header becomes `  <section>:` and the
block goes right after it; otherwise insert before the first item whose `name.lower()` is greater than
the new `name.lower()` (strict), else append at section end after backing up over trailing blank
lines (so the blank separator before the next section stays after the new block). Existing order is
not re-sorted. Source: `library.py:2742-2765`. Tags: cli/mvp/contract

**EDIT-09** Insert edge cases (all confirmed): inline `[ ]` (with a space) is not converted, producing
invalid YAML that WRITE-16 then rejects with a YAML parse error; items at 2-space indent make the
splice insert a 4-space block above them (invalid YAML, rejected); CRLF files get LF-only new lines;
a file without a trailing newline stays without one. Source: `library.py:2750`, `2721`. Tags: cli/mvp/contract

**EDIT-10** Remove: the item's block (item line through the line before the next item, or through
the line before the section end) is deleted, so any blank lines and comments **below** the item go
with it: removing the head entry also removes the blank line under it
(`tests/test_library.py:835`), and removing the **last** item of a section removes the blank
separator before the next section. If no items remain, every line between the header and the
section end (comments included, `tests/test_library.py:913`) is deleted and the header becomes
`  <section>: []`; when the section was last in the file this also removes the file's trailing
newline. Splice-then-remove restores the original bytes except when the section ended in a blank
line, which is lost (`tests/test_library.py:1046-1057`). Not found → `'<name>' not found in
<section>`. — `library.py:2768-2797`. Tags: cli/mvp/contract

**EDIT-11** Comments: a comment line inside an item block belongs to that item (removed/replaced with
it); a comment between items belongs to the preceding item. Source: `library.py:2788-2790`, `2823-2825`.
Tags: cli/mvp/contract

**EDIT-12** Replace (`update`): the target's block is replaced by `render_entry(new)`, keeping its
position. Consequences: any key in the entry other than name/description/source/requires is
**dropped**; block-style `requires` becomes flow style; comments in the block are dropped
(`tests/test_library.py:1015`); blank lines below the item are absorbed, for a middle item
(`tests/test_library.py:981`) as for the last one (the separator before the next section). Name and
type cannot change. Source: `library.py:2800-2826`, `5312-5313`. Tags: cli/mvp/contract

**EDIT-13** Batch add applies `splice_entry` once per entry in batch order to the same text, producing
one write (one commit/PR). Source: `library.py:5145-5148`. Tags: cli/mvp/contract

**EDIT-14** Doctor warns `<section> not alphabetically sorted` when a section's names differ from
`sorted(names, key=str.lower)`. Source: `library.py:6330-6333`. Tags: cli/mvp/contract

**EDIT-15** A new catalog scaffold (`catalog init`) is exactly the text below. Source: `library.py:5943-5952`.
Tags: cli/mvp/free (the comment text mentions the CLI; any scaffold the splice rules accept works)

```yaml
# Personal library catalog. Registered in the tool's config.local.yaml.
# Add entries with: library add --catalog {cid} --name … --description … --source …
#
# No default_dirs here: install locations belong to the tool, not the catalog.
library:
  skills: []
  agents: []
  prompts: []
```


### 2.8 Install

**INST-01** Destinations (global): skill → `~/.claude/skills/<name>/`; agent → `~/.claude/agents/<name>.md`;
prompt → `~/.claude/commands/<name>.md`; overridable per device via `default_dirs`. Source: `library.py:77-81`, `2284-2288`, `1785-1810`. Tags: cli/mvp/contract (where Claude Code loads them)

**INST-02** Overwrite: installing over an existing destination replaces it with no refusal, whatever
its state (`drifted` and `untracked` included); for a skill, files present only in the old copy are
deleted. The CLI reports the prior state only in `--dry-run`. Source: `library.py:2268-2281`, `4062-4093`.
Tags: cli/mvp/free (the app must instead protect unmanaged content, per decision)

**INST-03** Per-file change report for each installed item: `{"new_install": true}` when the
destination did not exist; otherwise `{new_install: false, added, removed, modified}` with sorted
relative paths (directory) or `[<dest file name>]` in `modified` (single file); `modified` is a deep
byte compare. Source: `library.py:2210-2242`. Tags: cli/mvp/free

**INST-04** After each item is copied, a receipt is written for its destination with `catalog`,
`catalog_key`, `scope`, `source`, `commit`, `source_oid`, `content_hash` of what landed, and
`installed_at` (UTC, `%Y-%m-%dT%H:%M:%SZ`). Source: `library.py:3291-3305`, `247-287`. Tags: cli/mvp/free

**INST-05** `use --dry-run` resolves names and dependency order and reports, per item, `{type, name,
catalog, dest, disabled, state}` where `state = dest_state(dest)` before any write; it does **not**
compute file-level diffs and makes no source-network calls (catalog refresh still happens). Source: `library.py:4062-4093`. Tags: cli/mvp/free

**INST-06** Given an item whose destination reads `disabled`, then `use` refetches into the archive
path instead (`Refreshed … (in the archive — still disabled)`); the receipt keeps naming the active
destination. Source: `library.py:3308-3333`, `3336-3361`, `4103-4113`. Tags: cli/drop/free
(rebuild: an off skill is reinstalled in place and stays off)

**INST-07** A failing item stops the run: JSON `{"status": "ERROR", "name": <failing item>, "reason":
<message>}`, exit 1; items already installed earlier in the order stay installed with receipts. Source: `library.py:4095-4119`; fixture `payloads/use-error.json`. Tags: cli/mvp/free

**INST-08** Local edits are detected only as `drifted` (hash mismatch vs receipt); there is no
per-file local-edit report before overwrite. Source: `library.py:1904-1927`. Tags: cli/mvp/free

### 2.9 Uninstall, disable/enable, sync

**UNIN-01** `uninstall` considers only scope destinations (`all` = global then project) or the
`--dir` destination, never every destination a receipt mentions. Source: `library.py:4298-4311`.
Tags: cli/mvp/free

**UNIN-02** Per destination: nothing at dest or its archive → prune the receipt silently; something
present and no receipt and not `--force` → refuse, reporting the occupied paths; else delete the dest
**and** its archived copy and drop the receipt. JSON `{"status": "OK" | "REFUSED", "results": [{type,
name, deleted: [paths], refused: [paths]}]}`; exit 2 when anything was refused. Source: `library.py:4313-4341`, `4381-4392`. Tags: cli/mvp/free
(rebuild: there is no archive copy; what happens to the skill's override on uninstall is open question Q17, architecture §4.5)

The four DIS rules describe the CLI's move-based mechanism, which the rebuild replaces (architecture §4.5). What
carries over: every name in a batch is resolved before anything changes (RES-05), and turning off a
skill that is already off is a successful no-op.

**DIS-01** `disable` (skills, global only): plan the whole batch first; refusals: not a skill (`only
skills can be disabled`), no global dir configured, both dest and archive exist (`a copy sits at both
<dest> and <archived>; remove the one you don't want, then retry`), neither exists (`not installed`).
Any refusal → `{"status": "ERROR", "problems": [{type, name, reason}]}` exit 1 and nothing moves. Source: `library.py:4452-4486`. Tags: cli/drop/free

**DIS-02** Then the archive directories are created up front (failure → `{"status": "ERROR",
"reason": "cannot create …"}` exit 1, nothing moved), then each move runs `move_tree(dest, archive)`;
already-disabled items are `moved: false` no-ops. Success: `{"status": "OK", "results": [{type, name,
moved, dest, archived}]}`. A mid-batch move failure → `{"status": "ERROR", "name", "reason",
"results": <done so far>}` exit 1. Receipts are not written. Source: `library.py:4488-4523`. Tags: cli/drop/free

**DIS-03** `move_tree(src, dst)`: refuse if `dst` exists; `os.replace` (atomic rename); on `EXDEV`
(cross-device) copy with symlinks preserved, verify `content_hash(dst) == content_hash(src)`, then
delete `src`; a hash mismatch deletes the partial copy and raises, leaving `src` intact. Source: `library.py:151-178`. Tags: cli/drop/free
(the rebuild keeps one move: migrating a CLI-parked copy back, which needs the same EXDEV-safe copy-verify-delete)

**DIS-04** `enable` mirrors `disable`: the destination comes from a receipt for `(name, type,
scope=global)` whose archive copy exists (so a copy returns where it was installed even if
`default_dirs` changed), else the derived global destination; refusals: not a skill, both present
(`a copy already sits at <dest>, so the archived copy at <archived> was left alone; …`), neither
present (`not installed`); the skills dir is created up front; `move_tree(archive, dest)`. `enable`
never fetches and never installs dependencies, although `library.py:4040-4042` and three docs say
dependencies skipped while disabled "are pulled in by enable" (§7). Source: `library.py:4536-4672`.
Tags: cli/drop/free

**SYNC-01** `sync` walks resolved entries once per **name** (the winning copy only); an entry counts
as installed when `installed_scopes` finds a copy anywhere under a configured dir (recursive, foreign
subtrees pruned); it is refreshed in its first scope (global first). An entry with no active copy but
an archived one is refreshed in its archive. Source: `library.py:4685-4706`, `1832-1871`. Tags: cli/mvp/free
(rebuild: the archive branch disappears; off skills are refreshed in place like any other)

**SYNC-02** Per active item: read `state` before writing; walk `resolve_deps` in the entry's own
catalog; for each item in the closure (dependencies and then the entry), skip if `source_unchanged`
(unless `--force`), else install, recording a dependency write `{type, name, catalog, scope, state,
required_by, changes}` when a dependency's prior state was not `installed` (deduplicated per run). Source: `library.py:4751-4785`, `3272-3288`. Tags: cli/mvp/free

**SYNC-07** Given an active entry `P` that requires a skill `D` which is **disabled**, when `sync`
runs, then `D`'s active destination reads `disabled`, `source_unchanged` is false, and `D` is
reinstalled into the active tree while its archived copy stays: two copies, reported as a dependency
write with state `disabled` ("was disabled"); `disable`/`enable` then refuse and doctor errors. `use`
handles the same case by refreshing `D` in its archive (DEP-07). Observed by the py-ops reader in a
sandbox. Source: `library.py:4758-4778` vs `4055-4059`, `3266`. Tags: cli/drop/free (looks accidental; moot in
the rebuild, which has no archive)

**SYNC-03** Because presence is by name and `source_unchanged` is false without a receipt, an
**untracked** (hand-installed) copy whose name matches a catalog entry is overwritten by `sync`. Source: `library.py:4699-4701`, `2529-2530`, `4769-4776`. Tags: cli/mvp/free (the rebuild must not do this to
unmanaged content; §7)

**SYNC-04** Failures are per item: `{type, name, catalog, reason}` in `failed`, the run continues.
Output `{"status": "OK" | "PARTIAL", "synced": [{type, name, catalog, scope, state, disabled, changes,
up_to_date}], "failed": […], "dependencies": […], "missing": […]}`; exit 1 when anything failed. The
`missing` list (receipts whose dest and archive are both gone, filtered by `--catalog`) is computed
**after** the run. Source: `library.py:4787-4796`, `1930-1953`; fixtures `payloads/sync.json`,
`payloads/sync-clean.json`. Tags: cli/mvp/free

**SYNC-05** Nothing installed and nothing missing → `{"status": "OK", "synced": [], "failed": [],
"dependencies": [], "missing": []}` (compact JSON, no indent) and exit 0. — `library.py:4709-4718`.
Tags: cli/mvp/free

**SYNC-06** Receipts with missing destinations are reported, never acted on (no reinstall). Source: `library.py:1930-1943`. Tags: cli/mvp/free

**SCAN-01** Presence scans (`holds_copy`) recurse under each install dir without following symlinks,
pruning any directory whose name starts with `.` or equals `synced` case-insensitively (Claude Code's
claude.ai-synced skills and its `.trash`). A skill is present when a directory named `<name>` exists at
any depth; agents/prompts when a file `<name>.md` exists at any depth. Source: `library.py:1813-1855`.
Tags: cli/mvp/free (the rule for "not ours" subtrees matters for unmanaged detection)

### 2.10 Doctor

`doctor [--deep] [--no-pull] [--json]` (`library.py:6347-6581`). Findings are `(catalog | null, entry |
null, message)`. JSON `{"status": "OK" | "PROBLEMS", "entries": <n>, "errors": [{catalog, entry,
message}], "warnings": [...]}`; exit 1 iff any error. Checks, in order:

| # | Check | Severity | Message (abridged) | Citation | Tags |
|---|---|---|---|---|---|
| 1 | Tool skill link `~/.claude/skills/library`: dangling | error | `skill link … is dangling` | `library.py:6354-6357` | cli/drop/free |
| 2 | link points elsewhere / occupied / missing | warning | `points at a different copy` / `a different copy … lives at` / `tool not linked at …` | `library.py:6358-6364` | cli/drop/free |
| 3 | No config file | error | `no local config at …` | `library.py:6368-6369` | cli/mvp/free |
| 4 | Config fails validation (every problem) / unparsable | error | `config at …: <problem>` / `config parse error: …` | `library.py:6370-6383` | cli/mvp/free |
| 5 | Legacy `catalog:` shape | warning | `run library catalog migrate` | `library.py:6389-6392` | cli/drop/free |
| 6 | `default_add_catalog` not writable | warning | `default_add_catalog names '<id>', which is not a writable catalog` | `library.py:6393-6399` | cli/mvp/free |
| 7 | Remote clone absent | warning | `catalog not yet cloned at …` | `library.py:6403-6405` | cli/mvp/free |
| 8 | Clone has no `origin` | error | `catalog clone is missing 'origin' remote` | `library.py:6407-6412` | cli/mvp/free |
| 9 | Clone origin ≠ configured repo | warning | `catalog clone remote (…) differs from config catalog.repo (…)` | `library.py:6413-6416` | cli/mvp/free |
| 10 | `git ls-remote --heads <repo>` fails / >15 s | error | `catalog repo unreachable (…)` / `catalog repo timed out` | `library.py:6417-6427` | cli/mvp/free |
| 11 | Any `pr`-mode catalog and `gh auth status` fails / `gh` missing | warning | `gh CLI not authenticated` / `gh CLI not installed` | `library.py:6429-6436` | cli/mvp/free |
| 12 | Tool clone has upstream changes (`git fetch --dry-run`, 10 s, silent on failure) | warning | `tool has upstream changes available; run library self-update` | `library.py:6438-6447` | cli/drop/free |
| 13 | Pull every remote (unless `--no-pull`), re-hydrate | — | (pull warnings on stderr) | `library.py:6449-6451` | cli/mvp/free |
| 14 | Clone behind origin | warning | `clone is <n> commit(s) behind origin/<branch> (…)` | `library.py:6453-6460` | cli/mvp/free |
| 15 | Catalog skipped (except an absent clone, already #7) | error | `<skip reason>` | `library.py:6462-6466` | cli/mvp/free |
| 16 | Catalog declares `default_dirs` | warning | `catalog declares default_dirs, which has no effect … In effect: …` | `library.py:6262-6270` | cli/mvp/free |
| 17 | Legacy `default` scope key in a catalog | warning | `default_dirs uses the legacy 'default' scope key` | `library.py:6272-6281` | cli/mvp/free |
| 18 | Duplicate names within one catalog | error | `duplicate name in <types>` | `library.py:6283-6291` | cli/mvp/contract |
| 19 | Local source path missing | error | `local source not found: …` | `library.py:6298-6302` | cli/mvp/free |
| 20 | Local source in a remote catalog | warning | `local source … won't resolve for teammates` | `library.py:6303-6306` | cli/mvp/contract |
| 21 | Unparseable source | error | `unrecognized source format: …` | `library.py:6307-6308` | cli/mvp/contract |
| 22 | Malformed requires (no `:` or unknown type) | error | `malformed requires ref '…'` | `library.py:6309-6312` | cli/mvp/contract |
| 23 | Dangling requires (with the catalogs that do define it, if any) | error | `dangling dependency '…'[; it exists in …, but dependencies resolve within one catalog — add a copy to '…']` | `library.py:6313-6324` | cli/mvp/contract |
| 24 | Dependency cycles (per catalog) | error | `dependency cycle: a -> b -> a` | `library.py:5629-5657`, `6326-6328` | cli/mvp/contract |
| 25 | Section not alphabetically sorted (case-insensitive) | warning | `<section> not alphabetically sorted` | `library.py:6330-6333` | cli/mvp/contract |
| 26 | `--deep`: each remote source's repo+branch reachable (`git ls-remote --heads <url> <branch>`, ssh then https; branch must appear) | error | `repo or branch unreachable: org/repo@branch` | `library.py:6335-6342`, `5660-5669` | cli/mvp/free |
| 27 | Name defined in ≥2 catalogs | warning | `'<n>' is defined in <k> catalogs — '<winner>'[ (pinned)] overrides …` | `library.py:6199-6220` | cli/mvp/free |
| 28 | Pin nothing can honour (no holder / unregistered / not a holder) | warning | three wordings | `library.py:6223-6245` | cli/mvp/free |
| 29 | Per winning name, per location: drifted | warning | `has local modifications; use/sync will overwrite them` | `library.py:6499-6502` | cli/mvp/free |
| 30 | untracked | warning | `has no install receipt — installed by hand, or before receipts existed` | `library.py:6503-6506` | cli/mvp/free |
| 31 | missing | warning | `receipt points at …, which no longer exists` | `library.py:6507-6510` | cli/mvp/free |
| 32 | Active copy and archived copy both present | error | `a copy sits at both … and …` | `library.py:6517-6521` | cli/drop/free |
| 33 | `setup.yaml` invalid / convention lint | error / warning | `invalid setup.yaml at …` / `setup.yaml …` | `library.py:6522-6529`, `320-691` | cli/later/free |
| 34 | Archive content with no catalog entry (reads the archive dir directly) | warning | `disabled content at … has no catalog entry — … restore it by hand with mv … or delete it` | `library.py:6531-6559` | cli/drop/free |

Note: doctor's pull uses `pull_all`, so an unclonable remote kills doctor itself (RCAT-05).

### 2.11 Migrations and legacy shapes

**MIG-01** Legacy config `catalog: {repo, yaml_path, branch}` is read as one remote catalog `{id:
shared, protected: true}`; both `catalog:` and `catalogs:` present is invalid. — `library.py:698-715`,
`874-886`. Tags: cli/mvp/free (the import must accept it)

**MIG-02** Any registry rewrite (`catalog add/init/remove`, `pin`, `unpin`) first converts a legacy
config to `catalogs:` form and reports `migrated` notes; `catalog migrate` does it explicitly
(`--dry-run` renders without writing). Source: `library.py:5751-5761`, `6132-6187`. Tags: cli/drop/free

**MIG-03** Migration lifts the shared catalog's `default_dirs` into the config (as `{section: [{scope:
path}, …]}`) unless the config already has a `default_dirs` override, which is kept; unrecognized
top-level keys are carried over. Source: `library.py:1044-1075`. Tags: cli/mvp/free (the import needs the
same lifting when importing a legacy config)

**MIG-04** Scope key `default` in any `default_dirs` is an alias of `project`. Source: `library.py:1504-1515`.
Tags: cli/drop/free

**MIG-05** `init` reads a `LIBRARY_YAML_PATH` from a legacy `## Variables` block in `SKILL.md` to
default `--yaml-path`. Source: `library.py:1372-1393`, `6675-6679`. Tags: cli/drop/free

**MIG-06** Receipt files with `version != 1` read as empty. Receipts without `catalog_key` match a
catalog by recorded id or by source URL (`_receipt_belongs_to`). Source: `library.py:227-228`,
`6000-6023`. Tags: cli/drop/free

**MIG-07** `init --force` re-points the `shared` catalog while preserving other catalogs and extra
keys; a broken existing config is overwritten and the dropped ids warned about. Source: `library.py:6613-6660`, `6696-6698`. Tags: cli/drop/free

### 2.12 Concurrency

**LOCK-01** `config.local.yaml` and `.installs.json` are written by `write_machine_file`: exclusive
`flock` on a sidecar `<file>.lock`, write to a temp file in the same dir, `fsync`, `os.replace`.
Readers take no lock and never see a half-written file. Source: `library.py:122-148`. Tags: cli/mvp/free

**LOCK-02** The lock covers only the write. Every receipt update is load → modify → save, so two
concurrent processes can lose one another's receipts ("Last writer wins; neither file merges"). Source: `library.py:129`, `284-286`, `2552-2555`, `4313-4340`. Tags: cli/mvp/free

**LOCK-03** Catalog files are written with a plain `Path.write_text` (not atomic, not locked); the
persistent clones have no tool-level lock (git's own `index.lock` is the only guard). Source: `library.py:3100`, `3130`, `2616-2619`. Tags: cli/mvp/free

### 2.13 Error conventions

**ERR-01** `die(msg, code=1)` prints `error: <msg>` to stderr and exits; `warn` prints `warning: <msg>`
to stderr. Most refusals go through `die`, so in `--json` mode they produce **no JSON** on stdout. Source: `library.py:88-94`. Tags: incidental/drop/free

**ERR-02** A `LibraryError` raised outside a `try` reaches `main()` uncaught (Python traceback on
stderr, exit 1). Reachable examples: `add`/`update --set-source`/`push` with an unrecognized source,
a multiline field, a PR-mode `git commit` failure, `remove` of an entry deleted upstream between the
registry read and the PR clone. Source: `library.py:4966`, `5362`, `5485`, `2676-2677`, `2884-2885`,
`2786`, `7035-7042`. Tags: incidental/drop/free

**ERR-03** Exit codes: `0` success; `1` failure (`die`, uncaught exception, `ERROR`/`PARTIAL`/
`PROBLEMS`); `2` "you decide" (`AMBIGUOUS`, `NOT_FOUND`, `AMBIGUOUS_CATALOG`, `uninstall` `REFUSED`);
`3` not bootstrapped. Full table in Appendix A. Tags: incidental/drop/free

## 3. Operation inventory

One section per CLI subcommand, with the Tauri command(s) that wrap it and the UI that exposes it.
Common facts, stated once:

- **Common flags** (`add_common`, `library.py:6790-6794`): `--json` (machine output), `--no-pull`
  (skip the catalog refresh, RCAT-06), `--cwd <dir>` (anchor for project scope). `--catalog <id>`
  (`add_catalog_flag`, `library.py:6796-6798`) restricts resolution to one active catalog (RES-06).
  Which subcommand has which (`library.py:6800-7030`):

  | subcommand | `--json` | `--no-pull` | `--cwd` | `--catalog` |
  |---|---|---|---|---|
  | init, self-update, link, suggest-source, unpin | own | – | – | – |
  | list, search, use, setup, show, uninstall, disable, enable, sync | ✓ | ✓ | ✓ | ✓ |
  | pin, doctor | ✓ | ✓ | ✓ | – |
  | add, update, push | ✓ | ✓ | – | ✓ |
  | remove | ✓ | ✓ | ✓ (`library.py:6943`) | ✓ |
  | catalog list/add/init/remove/migrate | ✓ | – | – | – |

  A flag a subcommand lacks is an argparse error, exit 2; flags must follow the subcommand
  (`library --json list` is exit 2). Tags: incidental/drop/free
- **Preconditions** for every command that calls `load_config` (`library.py:1078-1095`): config file
  exists (else die `no local config at <path>\n  run library init --repo <catalog-repo-url> first`),
  parses (a YAML syntax error is an uncaught traceback), is a mapping, passes `Config.problems`
  (die with the first problem). Reads take no lock.
- **Name-not-found shape** (show, use, setup, uninstall, disable, enable): RES-04, exit 2.
  `remove`, `update`, `push`, `pin` instead die `'<name>' not found in catalog` / pin's own messages,
  exit 1.
- **App error mapping** (`desktop/src-tauri/src/cli.rs:1698-1749`): exit 0 → parse stdout JSON (a
  parse failure is error kind `json`; stderr discarded); 3 → `not_bootstrapped`; 2 +
  `AMBIGUOUS_CATALOG` body → `ambiguous {catalogs}`; anything else → `cli {code, stderr}`, relabelled
  `not_configured` when `config.local.yaml` is absent. NOT_FOUND bodies (exit 2, empty stderr)
  surface as `cli {code: 2, stderr: ""}` (an empty message) for show/use/uninstall/disable/enable
  (§7). Tags: incidental/drop/free

### 3.1 `list`

- **Purpose:** every catalog entry (every copy, overridden ones included) with install status.
- **Flags:** `--check-remote` (`library.py:6820-6822`), `--json`, `--no-pull`, `--cwd`, `--catalog`.
- **Steps:** load config → refresh (RCAT-03) → staleness warnings (RCAT-07) → resolved entries →
  receipts → one `entry_record` per entry, in resolution order; with `--check-remote`, one
  `ls-remote` per source repo+branch and a probe only for moved heads (UPD-06). Never writes
  (`library.py:3443-3459`).
- **JSON:** array of entry records, keys in order `type, name, description, source, requires,
  installed, scopes, catalog, overridden_by, state, receipt, has_setup, locations, pinned`
  (`library.py:3423-3440`); `locations[]` = `{path, scope|null, state, archive_path, archived,
  receipt|null}` (`library.py:2022-2071`); receipts always carry all 11 keys (`library.py:232`).
  Fixture `payloads/list.json` predates `locations`, `pinned`, `catalog_key`, `source_oid` (§7).
- **States:** `not_installed, installed, disabled, missing, untracked, drifted, stale`.
- **Errors/exit:** 0; 1 via die (config, unknown `--catalog`, unclonable remote, no readable catalog).
- **Edge cases:** a `--dir`-only install reads `installed: false, scopes: [], state: "installed"`;
  a disabled copy reads `installed: true, scopes: ["global"], state: "disabled"`
  (`library.py:3401-3407`); human footer counts disabled as installed.
- **App:** `library_list(no_pull)` → `list [--no-pull] --json` (`desktop/src-tauri/src/lib.rs:66-69`,
  `cli.rs:939-949`); `--check-remote` never sent, so `stale` never appears. UI: catalog list
  (UI-10..21).
- Tags: cli/mvp/free

### 3.2 `search`

- **Purpose:** keyword lookup. **Flags:** `keyword` (positional), `--json`, `--no-pull`, `--cwd`, `--catalog`
  (`library.py:6827-6831`).
- **Steps:** load, refresh (no staleness warning), `fuzzy_candidates` over resolved entries
  (case-insensitive substring of name or description, overridden copies included)
  (`library.py:3503-3525`, `1557-1559`).
- **JSON:** array of entry records (never `stale`), `[]` when nothing matches. Exit 0.
- **App:** no Tauri command; the UI filters `library_list` client-side with ranking (UI-11, W18).
- Tags: cli/mvp/free (as an in-core filter)

### 3.3 `show`

- **Purpose:** everything about one entry. **Flags:** `name`, `--json`, `--no-pull`, `--cwd`, `--catalog`
  (`library.py:6856-6860`).
- **Steps:** load, refresh, resolve (RES-04 on miss, exit 2); subject = resolved copy or the
  `--catalog` copy; recompute install fields for an overridden subject (RES-08); `copies` from the
  unrestricted list; `requires` (transitive, install order, excluding the subject) and
  `unresolved_requires` within the subject's catalog; `dependents`; `installs` = receipts with that
  name **of any type**; `locations`; `source` (`library.py:3546-3643`).
- **JSON:** `{status: "OK", name, entry, copies: [{catalog, type, description, source, requires, wins,
  subject, pinned, overrides: [ids], overridden_by: [ids]}], requires: [{type, name, catalog,
  description}], unresolved_requires: [{ref, required_by, reason}], dependents: [{type, name, catalog,
  description, direct}], installs: [receipt], locations, has_setup, source}`; `source` is `{raw, kind:
  "unknown", error}` | `{raw, kind: "local", path, exists}` | `{raw, kind: github|bitbucket, org, repo,
  branch, file_path, clone_urls}` (`library.py:3528-3543`). Fixtures `payloads/show*.json` (stale:
  §7).
- **Errors/exit:** 0; 2 (NOT_FOUND/AMBIGUOUS); 1 via die.
- **App:** `entry_show(name, catalog)` → `show <name> [--catalog <id>] --json`
  (`desktop/src-tauri/src/lib.rs:75-82`, `cli.rs:952-964`); Rust drops `status`, top-level
  `locations`, `source.path`, `source.exists`. UI: entry page (UI-22..31).
- Tags: cli/mvp/free

### 3.4 `use` (install)

- **Purpose:** install or refresh one or more entries with their dependency closures.
- **Flags:** `name…` (one or more), `--global` | `--project` (mutually exclusive; `--global` is the
  default and a no-op), `--dir <path>` (custom base, not exclusive with either), `--dry-run`, `--json`, `--no-pull`, `--cwd`,
  `--catalog` (`library.py:6833-6846`).
- **Steps:** load, refresh, resolve every name first (RES-05); build the order (DEP-01, DEP-06,
  DEP-07); dry run → plan (INST-05); else one clone cache for the run, per item `_install_one`
  (or `_refresh_archived` for a disabled destination), receipt written per item (INST-04)
  (`library.py:3998-4154`).
- **JSON:** dry run `{status: "OK", dry_run: true, scope, requested: [names], overrides: [ids],
  overridden_by: id|null, would_install: [{type, name, catalog, dest, disabled, state}]}`; real
  `{status: "OK", installed: [{type, name, catalog, dest, verified, changes, disabled}], requested,
  overrides, overridden_by}`; failure `{status: "ERROR", name, reason}` (exit 1)
  (`library.py:4077-4126`). `overrides`/`overridden_by` describe only the **last** requested name
  (`library.py:4029`). Fixtures `payloads/use*.json` lack `requested` and `disabled` (§7).
- **Errors/exit:** 0 (JSON mode even with `verified: false`); 1 (ERROR; human mode with any
  unverified item, FETCH-12); 2 (NOT_FOUND/AMBIGUOUS, argparse); earlier items stay installed after a
  later failure (INST-07).
- **Disk/network:** catalog refresh; per source repo+branch one shallow clone (FETCH-02/04); skill
  destinations replaced wholesale; `.installs.json` rewritten per item.
- **Project scope / `--dir`** (documented, dropped): `--project` installs under
  `<project_cwd>/.claude/...`; `--dir` overrides the base for every item in the closure while the
  receipt's `scope` still says `global` or `project` (`library.py:3299-3303`, `4030`). Tags:
  cli/drop/free
- **App:** `entry_use_preview(names, project, catalog)` → `use <names…> [--project] [--catalog <id>]
  --dry-run --json` with `LIBRARY_CWD` = the picked project dir; `entry_use` → same without
  `--dry-run`, via `run_report`, non-OK status → error (`desktop/src-tauri/src/lib.rs:87-108`,
  `cli.rs:966-1036`). Rust drops `disabled` and `dry_run`. UI: install page and bulk panel
  (UI-32..37), pin-and-switch (UI-30).
- Tags: cli/mvp/free; FETCH-06/07 file mapping is contract

### 3.5 `setup` (deferred)

- **Purpose:** report an installed skill's `setup.yaml`, prerequisites and secret presence.
- **Flags:** `--scaffold` (prints `SETUP_TEMPLATE` and exits 0 before loading config), `name`,
  `--json`, `--no-pull`, `--cwd`, `--catalog` (`library.py:6848-6854`).
- **Steps/JSON:** `{status: "OK", name, type, catalog, installed, dest, has_setup, manifest, problems,
  prerequisites: [{kind, value, met, detail}], secrets: [{key, delivery, optional, present, detail}],
  configured: bool|null, ready}` (`library.py:4157-4268`, `320-691`); validation rules
  `library.py:342-427`. Fixtures `payloads/setup-*.json` (recorded by
  `desktop/src-tauri/tests/fixtures/record_setup_payloads.py`). Exit 0/2/1.
- **App:** `entry_setup(name)` (`desktop/src-tauri/src/lib.rs:315-317`, `setup.rs:179-192`);
  `SetupReadiness.vue`.
- Tags: cli/later/free

### 3.6 `pin`

- **Purpose:** list pins, or pin a name to a catalog and reconcile installed copies.
- **Flags:** `name?`, `catalog?` (positionals), `--no-install`, `--dry-run`, `--json`, `--no-pull`, `--cwd`
  (`library.py:6862-6871`).
- **Steps:** load, refresh; no name → list; refusals (RES-13); `--dry-run` → assessment only; else
  migrate-if-legacy, write `pins[name]`, re-load, assess (RES-15); human mode then auto-installs via
  `use` unless blockers or `--no-install` (RES-16); JSON never installs (`library.py:3846-3962`).
- **JSON:** list `{status: "OK", pins: [{name, catalog, holders, dangling, resolves_to}]}`; dry run
  `{status: "OK", dry_run: true, name, catalog, previous, holders, only_holder, switch, migrated: []}`;
  write `{status: "OK", name, catalog, previous, holders, only_holder, switch: {switchable, simple,
  stale: [{dest, scope, state, from}], blockers: [str], unresolved_requires, new_dependencies: [names],
  dependents: [{name, catalog, direct}]}, migrated: [notes]}`. No fixture exists.
- **Errors/exit:** 0; 1 via die (RES-13).
- **App:** `pins_list` → `pin --json`; `entry_pin_preview` → `pin <n> <c> --dry-run --json`;
  `entry_pin` → `pin <n> <c> --json` (`desktop/src-tauri/src/lib.rs:111-137`, `cli.rs:1488-1585`).
  UI: entry page pin flow (UI-29/30), install-time "Always use" (UI-32), Catalogs pinned list (UI-42).
- Tags: cli/mvp/free

### 3.7 `unpin`

- **Flags:** `name`, `--json` (`library.py:6873-6876`). No refresh.
- **Steps:** canonical raw config (dies `cannot edit <path>: <problem>` on an invalid file); not
  pinned → die `'<name>' is not pinned (pinned: …|none)`; pop; drop an empty `pins`; write; report
  the new resolution (`library.py:3965-3995`).
- **JSON:** `{status: "OK", name, was, resolves_to, migrated}`. Installed copies untouched.
- **App:** `entry_unpin(name)` (`desktop/src-tauri/src/lib.rs:140-143`, `cli.rs:1588-1590`); UI
  "Clear pin" (UI-29, UI-42).
- Tags: cli/mvp/free

### 3.8 `uninstall`

- **Flags:** `name…`, `--scope global|project|all` (default `all`), `--dir`, `--force`, `--json`, `--no-pull`, `--cwd`,
  `--catalog` (`library.py:6878-6888`).
- **Steps:** load, refresh, resolve all names first; per entry, sequentially, `uninstall_entry`
  (UNIN-01, UNIN-02) (`library.py:4344-4408`, `4271-4341`).
- **JSON:** `{status: "OK" | "REFUSED", results: [{type, name, deleted: [paths], refused: [paths]}]}`;
  exit 2 when anything was refused (a mixed batch is still `REFUSED`), else 0. Dependencies are never
  uninstalled.
- **App:** `entry_uninstall(names, scope, force)` → `uninstall <names…> --scope <s> [--force] --json`;
  exit 2 + `REFUSED` parsed as a report (`desktop/src-tauri/src/lib.rs:151-159`, `cli.rs:1076-1113`).
  UI: per-copy two-step uninstall (UI-26), bulk uninstall (UI-37), never forced in bulk.
- Tags: cli/mvp/free; `--scope project` and `--dir` cli/drop/free

### 3.9 `disable` / 3.10 `enable`

- **Flags:** `name…`, `--json`, `--no-pull`, `--cwd`, `--catalog` (`library.py:6890-6904`). Skills only, global only.
- **Steps:** DIS-01..04 (`library.py:4411-4672`); receipts read (enable) but never written.
- **JSON:** `{status: "OK", results: [{type, name, moved, dest, archived}]}`; refusals `{status:
  "ERROR", problems: [{type, name, reason}]}`; mkdir failure `{status: "ERROR", reason}`; mid-batch
  move failure `{status: "ERROR", name, reason, results}`; exit 1 for every ERROR, 2 for NOT_FOUND.
- **Edge cases:** `enable` installs no dependencies (contrary to `library.py:4040-4042` and three
  docs, §7); an untracked skill can be disabled (receipts not consulted).
- **App:** `entry_disable(names)` / `entry_enable(names)` via `run_report`, non-OK → error with
  `problems` joined as `name: reason` lines (`desktop/src-tauri/src/lib.rs:164-180`,
  `cli.rs:1117-1175`). UI: list switch (UI-20), disabled tab (UI-13), detail note (UI-23).
- Tags: cli/mvp/free

### 3.11 `sync`

- **Flags:** `--force`, `--json`, `--no-pull`, `--cwd`, `--catalog` (`library.py:6906-6911`).
- **Steps:** SYNC-01..06, UPD-04/05 (`library.py:4675-4842`).
- **JSON:** `{status: "OK" | "PARTIAL", synced: [{type, name, catalog, scope, state, disabled, changes,
  up_to_date}], failed: [{type, name, catalog, reason}], dependencies: [{type, name, catalog, scope,
  state, required_by, changes}], missing: [{type, name, catalog, scope, dest}]}`; exit 1 iff `failed`
  non-empty. Fixtures `payloads/sync.json`, `payloads/sync-clean.json` (lack `disabled`).
- **Edge cases ([observed] by the py-ops reader in a sandbox):** a **disabled dependency** of an
  active entry is reinstalled into the active tree (its destination reads `disabled`, so it is "not
  unchanged"), leaving active + archived copies, after which `disable`/`enable` refuse and doctor
  errors. `use`, by contrast, refreshes it in place (`library.py:4055-4059` vs `4758-4778`) (§7).
  `--dir`-only installs are never synced; a project copy beside a global one is never refreshed.
- **App:** `catalog_sync(force)` → `sync [--force] --json`, accepts OK/PARTIAL
  (`desktop/src-tauri/src/lib.rs:184-186`, `cli.rs:1047-1062`). UI: Sync page (UI-38).
- Tags: cli/mvp/free

### 3.12 `add`

- **Flags:** `--name`, `--description`, `--source`, `--batch <file>`, `--type skill|agent|prompt`,
  `--requires a,b`, `--allow-local`, `--dry-run`, `--json`, `--no-pull`, `--catalog`
  (`library.py:6913-6928`).
- **Steps:** parse the request before loading config (batch rules: no `--name`/`--source` with
  `--batch`; file must be a non-empty list or `{entries: [...]}`; items may name one `catalog`; it
  must agree with `--catalog`) → load, refresh, `require_entries` → `write_target` (WRITE-01..03) →
  `_prepare_entry` per item: required fields; type inferred from the lower-cased source string
  (`skill.md` → skill, `agent.md` → agent, else prompt); `parse_source` (uncaught on failure, ERR-02);
  local path must exist; local-source refusal for remote destinations (WRITE-05); install-dir check
  (WRITE-06); requires validation (DEP-11) → duplicate names in the batch → duplicate in the
  destination catalog (any section) die `'<n>' already in <catalog '<id>'|catalog> (type <t>); use
  library use to refresh or push to update` → override warnings → unknown-dependency warnings
  (DEP-10) → splice each entry (EDIT-08, EDIT-13) → verify → write per mode (WRITE-07..18)
  (`library.py:5055-5193`, `4939-5002`).
- **JSON:** dry run `{status: "DRY_RUN", would_change: true, added, branch, diff, mode, catalog[,
  path]}`; real `{status: "OK", added, mode, catalog, …write keys}` where `added` is `{type, name,
  section}` for one entry and an array for a batch. Fixture `payloads/add.json` (local mode, exact).
- **Errors/exit:** 0; 2 (`AMBIGUOUS_CATALOG`); 1 (die; traceback for splice/parse/PR-git failures).
- **App:** `entry_add(request)` → `add --name N --type T --description D --source S [--requires a,b]
  [--catalog C] --json`; never `--allow-local`, `--dry-run`, `--batch` (`desktop/src-tauri/src/lib.rs:193-195`,
  `cli.rs:1217-1238`). UI: Add entry (UI-46), local catalogs only (UI-40).
- Tags: cli/mvp/contract (the catalog bytes and write mode); `--batch` cli/mvp?/contract (mvp?
  because the app never sends it, but batch add is one PR for several entries, which the decisions'
  "add" may want).

### 3.13 `suggest-source`

- **Flags:** `path`, `--json` (`library.py:6930-6934`). No config needed; offline.
- **Steps/JSON:** `{status: "OK" | "NONE", path, suggestion, reason, install_dir: {section, scope,
  path}|null}`, exit 0 either way; reasons verbatim at `library.py:1642-1673`; a directory resolves to
  its `SKILL.md`/`AGENT.md`; branch = current branch (`HEAD` when detached/unborn, `main` when empty)
  (`library.py:5005-5052`).
- **App:** `source_suggestion(path)` (`desktop/src-tauri/src/lib.rs:260-266`); UI: AddEntry source
  lookup (UI-46).
- Tags: cli/mvp?/free (mvp? because it is not named in the decisions but the add flow depends on it
  to keep local paths out of shared catalogs).

### 3.14 `remove`

- **Flags:** `name`, `--purge`, `--dry-run`, `--json`, `--no-pull`, `--cwd`, `--catalog`
  (`library.py:6936-6946`).
- **Steps:** load, refresh, resolve (die `'<name>' not found in catalog`); held by several catalogs
  without `--catalog` → `AMBIGUOUS_CATALOG` exit 2 (WRITE-04); `write_target(entry.catalog)` for the
  read-only refusal; dependents warning (DEP-09); `remove_entry` (EDIT-10/11) → verify → write per
  mode; `--purge` (not on dry runs, after the write) → `uninstall_entry(scope=all, force=True)`
  (`library.py:5196-5284`).
- **JSON:** dry run `{status: "DRY_RUN", would_change: true, removed: {type, name, section},
  dependents: ["type:name"], branch, diff, mode, catalog[, path]}`; real `{status: "OK", removed,
  deleted: [paths], dependents, …write keys}`. Fixtures `payloads/remove*.json` (exact).
- **App:** `entry_remove_preview(name, catalog)` / `entry_remove(name, catalog, purge)`
  (`desktop/src-tauri/src/lib.rs:211-232`, `cli.rs:1274-1311`); UI: EntryRemove panel (UI-48).
- Tags: cli/mvp/contract

### 3.15 `update`

- **Flags:** `name`, `--set-description`, `--set-source`, `--add-requires`, `--remove-requires`,
  `--set-requires` (empty string clears), `--allow-local`, `--dry-run`, `--json`, `--no-pull`,
  `--catalog` (`library.py:6948-6963`).
- **Steps:** at least one change flag (die otherwise); `--set-requires` excludes add/remove; load,
  refresh, registry typo check; `AMBIGUOUS_CATALOG` without `--catalog` when several hold the name;
  `write_target(base.catalog)`; `--set-source` checks (WRITE-05/06; a missing local path is **not**
  checked, unlike `add`); `edit` recomputed from the text being written (WRITE-15): entry gone → die
  `'<name>' was removed from the catalog upstream; nothing to update`; add/remove refs with warnings on
  redundancy; unknown-dependency warnings; field-level no-op → no write; else `replace_entry`
  (EDIT-12) (`library.py:5287-5442`). Empty `--set-description ""`/`--set-source ""` mean "not given".
- **JSON:** no-op `{status: "OK", name, changed: false}` (no write keys); dry run `{status:
  "DRY_RUN", would_change: true, name, branch, diff, …}`; real `{status: "OK", name, changed: true,
  …write keys}`. Fixtures `payloads/update*.json` (exact).
- **App:** `entry_update(request)` → `update <name> --catalog <c> [--set-description D]
  [--set-source S] [--set-requires a,b|""] --json` (`desktop/src-tauri/src/lib.rs:202-207`,
  `cli.rs:1250-1266`); UI: EntryEditor (UI-47).
- Tags: cli/mvp/contract

### 3.16 `push`

- **Flags:** `name`, `--from project|global|default|<dir>`, `--message`, `--no-pull`, `--dry-run`,
  `--json`, `--catalog` (`library.py:6965-6975`).
- **Steps:** load, refresh, resolve (die on miss); locate the local copy (`--from` dir = the base
  holding `<name>`; no `--from` → `installed_scopes`, die when none or several; disabled copies are not
  found); provenance `note` (`push_source_warning`, `library.py:1307-1355`) to stderr and every JSON
  payload; `parse_source` (uncaught); **local source**: compare and copy over the source in place
  (skill: `rmtree` + `copytree`, deleting files only the source had), no git; **remote source**
  (GitHub **and** Bitbucket): full single-branch clone ssh-then-https, copy in, `checkout -b
  library/update-<name>-<ts>`, `add`, `diff --cached --quiet` (nothing staged → `changed: false`),
  `commit -m <--message or "library: updated <name>">`, dry run → `git show HEAD`, else `_create_pr`
  with body ``Updated <type> `<name>` via `library push`.`` (`library.py:5445-5622`). Receipts are not
  updated, so the installed copy keeps reading `drifted` until the next install.
- **JSON:** local dry `{status: "DRY_RUN", would_change, name, catalog, dest, note}`; local real
  `{status: "OK", name, catalog, note, changed, pushed: false, dest}`; remote nothing-to-push
  `{status: "DRY_RUN", would_change: false, …, branch, note}` / `{status: "OK", changed: false, …}`;
  remote dry `{status: "DRY_RUN", would_change: true, name, catalog, branch, diff, note}`; remote real
  `{status: "OK", name, catalog, changed: true, note, method, branch, pr_url|compare_url}`; git
  failure inside the flow `{status: "ERROR", name, catalog, reason, note}` exit 1; push rejection and
  gh failures are dies (stderr only).
- **App:** `entry_push_preview(name, from)` / `entry_push(name, from, message)`; `from` is always
  sent (`desktop/src-tauri/src/lib.rs:236-257`, `cli.rs:1313-1381`); UI: "Send edits back" (UI-27).
- Tags: cli/mvp/free (PR text and branch naming are team-visible but not catalog bytes)

### 3.17 `doctor`

- **Flags:** `--deep`, `--json`, `--no-pull`, `--cwd` (`library.py:7027-7030`).
- **Steps:** the 34 checks of §2.10; reads the config itself so config problems are findings, not
  fatal (`library.py:6347-6581`).
- **JSON:** `{status: "OK" | "PROBLEMS", entries, errors: [{catalog, entry, message}], warnings:
  [...]}`; exit 1 iff errors. Touches the network even with `--no-pull` (`ls-remote` per remote,
  `gh auth status`, tool `fetch --dry-run`). Fixtures `payloads/doctor.json`, `doctor-problems.json`
  (the latter's error text is not one the code produces, §7).
- **App:** `catalog_doctor(deep)` via `run_report` (`desktop/src-tauri/src/lib.rs:269-272`,
  `cli.rs:1178-1184`); UI: Doctor (UI-39).
- Tags: cli/mvp/free; checks 1, 2, 5, 12, 33 tagged individually in §2.10

### 3.18 `catalog list`

- **Flags:** `--json` (`library.py:6979-6981`). Offline (RCAT-09).
- **JSON:** `[{precedence (1-based), id, kind, location, write_mode, writable, entries|null,
  skipped|null}]` (`library.py:5818-5858`). Fixture `payloads/catalogs.json`.
- **App:** `registry_list` (`desktop/src-tauri/src/lib.rs:306-308`); UI: tabs, summary strip,
  Catalogs page (UI-13, UI-15, UI-41).
- Tags: cli/mvp/free

### 3.19 `catalog add`

- **Flags:** `--id` (required), `--path` | `--repo` (exactly one), `--branch` (default `main`),
  `--yaml-path` (default `library.yaml`), `--read-only`, `--git-commit`, `--protected`, `--position
  first|last` (default `first`), `--json` (`library.py:6983-6999`).
- **Steps:** build the item (local: `{id, path}` + `git_commit`; remote: `{id, repo, yaml_path, branch,
  protected: bool(--protected)}` — **unprotected by default**; `--read-only` → `writable: false`;
  flags for the other kind silently ignored) → `register_catalog`: validate the item alone, migrate a
  legacy config, refuse a duplicate id, `probe_catalog` (remote: clone into the clone dir, reusing an
  existing dir **without checking its origin**; must have a `library:` mapping), delete a fresh clone on
  failure, insert first/last, write config (`library.py:5861-5940`, `5764-5779`).
- **JSON:** `{status: "OK", id, kind, precedence, registered, write_mode, writable, entries, location,
  migrated}`.
- **Errors:** `catalog add needs a non-empty --id`; `… exactly one of --path (local) or --repo
  (remote)`; `cannot register catalog '<id>': <problem>`; `catalog '<id>' is already registered (ids:
  …)`; `'<id>' is not a usable catalog: <problem>\n  <config> was not modified`; exit 1.
- **App:** `registry_add(request)` with `create: false` → `catalog add --id <id> --position
  first|last [--path P] [--repo R] [--branch B] [--protected] --json`; never `--yaml-path`,
  `--read-only`, `--git-commit` (`desktop/src-tauri/src/lib.rs:285-291`, `cli.rs:1402-1432`). UI:
  RegisterCatalog "existing" and "remote" modes (UI-44).
- Tags: cli/mvp/free

### 3.20 `catalog init`

- **Flags:** `path`, `--id` (default `personal`), `--git-commit`, `--position`, `--json`
  (`library.py:7001-7009`).
- **Steps:** path must start with `/` or `~`; an existing directory means `<dir>/library.yaml`,
  otherwise the path itself is the file whatever its name (`catalog init ~/new-cat` creates a file
  named `new-cat`, observed); refuse an existing file; write the scaffold (EDIT-15); register; on
  failure delete the scaffold (`library.py:5955-5997`). Not committed even with `--git-commit`.
- **JSON:** registration result + `created: <file>`.
- **App:** `registry_add` with `create: true` → `catalog init <path or ""> --id <id> --position …
  --json` (`cli.rs:1409-1415`). UI: "Create a new empty one" (UI-44); FirstRun uses `catalog_init`
  (deferred).
- Tags: cli/mvp/free

### 3.21 `catalog remove`

- **Flags:** `id`, `--purge-clone`, `--purge-installs`, `--json` (`library.py:7011-7019`). Offline.
- **Steps:** canonical config; unknown id → die `unknown catalog '<id>' (registered: …)`; only catalog
  → die; pop and write the config **first**; `--purge-installs` → delete every receipt destination
  attributed to the catalog (exact `catalog_key` if recorded, else id or source match), anywhere
  (including `--dir` and other projects), clearing receipts whose dest is gone; archived (disabled)
  copies are **not** deleted, only their receipts dropped; `--purge-clone` → delete the clone
  (`library.py:6000-6129`). Pins and `default_add_catalog` naming the id are not cleaned.
- **JSON:** `{status: "OK", id, purged_clone, clone_kept_at, purged_installs, cleared_receipts,
  migrated}`.
- **App:** `registry_remove(id, purge_clone, purge_installs)` (`desktop/src-tauri/src/lib.rs:295-302`,
  `cli.rs:1445-1459`); UI: Unregister confirm (UI-43).
- Tags: cli/mvp/free

### 3.22 `catalog migrate`

- **Flags:** `--dry-run`, `--json` (`library.py:7021-7025`). Rewrites a legacy `catalog:` config
  (MIG-01..03); JSON `{status: "OK", changed: false, reason, changes: []}` / `{status: "DRY_RUN",
  changed: true, changes, config}` / `{status: "OK", changed: true, changes, path}`
  (`library.py:6132-6187`). No Tauri command.
- Tags: cli/drop/free (the import reads legacy configs directly)

### 3.23 `init`

- **Flags:** `--repo` (required), `--yaml-path`, `--branch` (required), `--autopush`, `--force`,
  `--json` (`library.py:6800-6807`).
- **Steps:** refuse an existing config without `--force`; default yaml path from a legacy SKILL.md
  block (MIG-05); preserve other catalogs and keys on re-init (MIG-07), else write the commented
  template; load; re-clone `.catalog-repo` on `--force` or origin mismatch; clone; verify the catalog
  file; on failure restore the previous config bytes (the clone is **not** restored, observed)
  (`library.py:6663-6761`). Uses the first **remote** catalog as "shared", which is wrong when a remote
  personal catalog precedes it (§7).
- **JSON:** `{status: "OK", config, catalog_repo, catalog_yaml_path, catalog_branch, autopush,
  catalog_clone, catalog_entries, kept_catalogs}`.
- **App:** `catalog_init(repo, branch)` → `init --repo R --branch B --json` without `settle`
  (`desktop/src-tauri/src/lib.rs:275-282`, `cli.rs:1186-1205`); UI: FirstRun (deferred).
- Tags: cli/drop/free (replaced by first-run "add a catalog" + one-time import)

### 3.24 `self-update`

- **Flags:** `--json` (`library.py:6809-6811`). `git -C <tool> pull --ff-only`; JSON `{status: "OK",
  output}` / `{status: "ERROR", message}` exit 1 (`library.py:6764-6779`). Doctor check 12 suggests
  it. No Tauri command.
- Tags: cli/drop/free (replaced by Homebrew/updater distribution)

### 3.25 `link`

- **Flags:** `--dir`, `--force`, `--json` (`library.py:6813-6817`). Symlinks `<dir>/library` →
  the tool clone; actions `in-place`, `already-linked`, `created`, `repaired`, `repointed`; refuses an
  occupied path and (without `--force`) a symlink to another copy (`library.py:5672-5728`). No Tauri
  command.
- Tags: cli/drop/free (the importer reads this symlink to locate the Python tool, architecture §4.2)

### 3.26 Deferred Tauri commands (no CLI subcommand of their own)

| Command | What it does | Citation | Tags |
|---|---|---|---|
| `bootstrap_tool` | runs `<python> bootstrap.py --json --dir <home>` | `desktop/src-tauri/src/lib.rs:410-413`, `cli.rs:1603-1651` | incidental/drop/free |
| `agent_available` | `claude --version` exits 0 | `desktop/src-tauri/src/lib.rs:404-407`, `agent.rs:169-177` | app/later/free |
| `walkthrough_start` / `walkthrough_say` / `walkthrough_end` | guided setup over `claude -p` + loopback MCP | `desktop/src-tauri/src/lib.rs:361-397`, `walkthrough.rs:72-302`, `agent.rs:121-700`, `mcp.rs:150-821` | app/later/free |
| `submit_secret` / `decline_secret` | answer the pending secret ask | `desktop/src-tauri/src/lib.rs:325-355`, `secrets.rs:134-551` | app/later/free |
| `entry_setup` | `setup <name> --json` with an exit-2 message rewrite | `desktop/src-tauri/src/lib.rs:315-317`, `setup.rs:179-192` | app/later/free |
| `catalog_init` | `init --repo --branch` (FirstRun) | `desktop/src-tauri/src/lib.rs:275-282` | app/later/free |

The app binary also doubles as a Claude Code PreToolUse hook (`--pretooluse-hook`,
`desktop/src-tauri/src/main.rs:1-15`, `agent.rs:249-347`) and starts the loopback MCP server at
launch, aborting startup if it cannot bind (`desktop/src-tauri/src/lib.rs:442-450`). Tags: app/later/free

## 4. UI behavior inventory

Citations below are relative to `desktop/src/` unless they start with another top-level directory.
Every UI behavior is `app` origin and `free` compat; scope is `mvp` unless tagged otherwise. Tags are
given per subsection and override per item where they differ.

### 4.1 Architecture of the current UI

- `main.ts` imports `assets/tokens.css`, applies the stored appearance before mount, mounts `App.vue`
  (`main.ts:5-12`). Every backend call is a direct `invoke()` inside a component (no service module),
  almost always wrapped in `withActivity(label, fn)` (`commandActivity.ts:46-53`). Tags: app/mvp/free
- Shared state is module-level (`commandActivity.ts`, `toasts.ts`), not Pinia; no router: navigation is a
  `v-if` chain over refs in `App.vue` (`App.vue:503-604`). Tags: app/mvp/free
- UI-side domain logic lives in `catalog.ts` (row building, search, badges, plans, wording). This is
  logic the TS core should own (§6 W-UI1). Tags: app/mvp/free
- No keyboard shortcuts, no Escape handling, no programmatic focus management; only `autofocus` on
  AddEntry's Name field (`components/AddEntry.vue:292`) and `@keydown.enter` in the deferred
  walkthrough (`components/Walkthrough.vue:248`). Tags: app/mvp/free

Tauri command call sites (complete):

| Command | Args | Caller |
|---|---|---|
| `library_list` | `{noPull: !pull}` | `App.vue:246` |
| `registry_list` | — | `App.vue:247` |
| `entry_show` | `{name, catalog}` | `components/EntryDetail.vue:116` |
| `entry_use_preview` | `{names:[name], project, catalog}` / `{names}` | `components/InstallPreview.vue:150-154`, `components/BulkInstall.vue:105` |
| `entry_use` | same / `{names}` / `{names:[name], project:null, catalog:null}` | `components/InstallPreview.vue:178-182`, `components/BulkInstall.vue:120`, `components/EntryDetail.vue:246` |
| `entry_uninstall` | `{names:[name], scope, force}` / `{names, scope:"global", force:false}` | `components/UninstallControl.vue:38-42`, `components/BulkInstall.vue:140-144` |
| `entry_disable` / `entry_enable` | `{names:[name]}` | `components/EntryList.vue:141`, `149` |
| `entry_pin_preview` / `entry_pin` | `{name, catalog}` | `components/EntryDetail.vue:221`, `241`, `components/InstallPreview.vue:173` |
| `entry_unpin` | `{name}` | `components/EntryDetail.vue:305`, `components/Catalogs.vue:218` |
| `pins_list` | — | `components/Catalogs.vue:207` |
| `entry_push_preview` / `entry_push` | `{name, from}` / `{name, from, message}` | `components/PushControl.vue:57`, `71-75` |
| `entry_add` | `{request:{name, type, description, source, requires, catalog}}` | `components/AddEntry.vue:204-213` |
| `entry_update` | `{request:{name, catalog, description, source, requires}}` | `components/EntryEditor.vue:101-103` |
| `entry_remove_preview` / `entry_remove` | `{name, catalog}` / `+purge` | `components/EntryRemove.vue:62-65`, `81-85` |
| `source_suggestion` | `{path}` | `components/AddEntry.vue:114` |
| `catalog_sync` | `{force}` | `components/Sync.vue:45` |
| `catalog_doctor` | `{deep}` | `components/Doctor.vue:24` |
| `registry_add` / `registry_remove` | `{request:{id, path, repo, branch, wins, protected, create}}` / `{id, purgeClone, purgeInstalls}` | `components/RegisterCatalog.vue:194-204`, `components/Catalogs.vue:157-161` |
| deferred: `bootstrap_tool`, `catalog_init`, `entry_setup`, `agent_available`, `walkthrough_*`, `submit_secret`, `decline_secret` | — | `components/FirstRun.vue`, `SetupReadiness.vue`, `Walkthrough.vue`, `SecretPrompt.vue` |

### 4.2 App shell, loading, freshness (`App.vue`)

Tags: app/mvp/free

- **UI-01** On launch the app awaits the command-event subscription, then loads with a pull
  (`library_list {noPull:false}` + `registry_list` in parallel); after any write it reloads **without**
  pulling; the header **Refresh** pulls; after Sync it marks the time and reloads without pulling. Source: `App.vue:226-263`, `483-496`, `622`; spec `App.spec.ts:152-195`.
- **UI-02** A failed load sets the error and **empties both lists** (no stale list kept). Source: `App.vue:256-259`; spec `App.spec.ts:263-276`.
- **UI-03** First load shows `Busy "Reading the catalog…"`; later loads keep the list and dim it
  (`is-refreshing`: opacity 0.6 after 0.4 s, `pointer-events: none`; no transition under reduced
  motion). Source: `App.vue:743`, `784`, `1012-1038`; spec `App.spec.ts:170-193`.
- **UI-04** Freshness cue beside the counts: "refreshed just now" / "… 1 minute ago" / "… N minutes
  ago" / "… 1 hour ago" / "… N hours ago", ticking every 60 s; absent until the first pull. Source: `App.vue:465-480`, `663-665`.
- **UI-05** No offline detection, no stale-data banner, no auto-refresh; a failed pull shows the error
  banner. Source: `App.vue:256-259` (grep for offline/onLine found only static help text).
- **UI-06** Error routing: `not_bootstrapped`/`not_configured` → deferred `FirstRun`; other errors →
  `StatusBanner kind=error` with `describeAppError` text in place of the list; no Retry button. Source: `App.vue:289-304`, `523-528`, `744-748`. Tags: app/later/free for the FirstRun routing.
- **UI-07** Browser-only (no Tauri) mode shows a fixed warning and sends no commands. Source: `App.vue:510-521`; spec `App.spec.ts:249-261`. Tags: incidental/drop/free
- **UI-08** View stack, exactly one view at a time, in priority order: browser-only banner → FirstRun
  → Doctor → Sync → AddEntry → Catalogs → Walkthrough → EntryInstall → EntryDetail → catalog list.
  Entries keep a back-stack (`trail`), each stop `{name, catalog}`; the trail is pruned of names that
  vanished after a reload. Source: `App.vue:99-106`, `272-281`, `503-604`.
- **UI-09** Window chrome: fixed frame, only `.view__body` scrolls (`overflow-y:auto`,
  `overscroll-behavior: contain`, `scrollbar-gutter: stable`); content measure `max(1.25rem, (100% −
  860px)/2)` padding; button scale (default/`.btn-sm`/`.btn-xs`/`.ghost`/`.danger`, disabled opacity
  0.45). Source: `App.vue:818-1053`; specs `pageChrome.spec.ts`, `assets/buttons.spec.ts`.

### 4.3 Catalog list view (`App.vue:609-794`, `components/EntryList.vue`, `catalog.ts`)

Tags: app/mvp/free

- **UI-10** Header: title, AppearanceToggle, search input (`type=search`, placeholder "Search skills,
  agents, prompts…", **no label**), ghost buttons Refresh / Catalogs / Sync. Enter in the search does
  nothing. Source: `App.vue:610-636`.
- **UI-11** Search semantics (`searchRows`): `q = query.trim().toLowerCase()`; empty → all rows; one
  substring (no tokenization) over `name` and `description` only; rank 0 = name starts with q, 1 =
  name contains q, 2 = description contains q; others dropped; stable sort so copies of a name stay
  adjacent. No type, installed, or source filters exist. Source: `catalog.ts:103-117`; spec
  `catalog.spec.ts:160-192`. (CLI `search` is never called; it uses the same fields unranked,
  `library.py:1557-1559`.)
- **UI-12** Rows: All tab → every copy (`allRows`, copies grouped at the first copy's position) or
  winners only when **Hide overridden** is ticked; catalog tab → that catalog's copies
  (`catalogRows`); disabled tab → winners whose state is `disabled`. Order is CLI order (no sort). Source: `App.vue:383-396`, `catalog.ts:54-91`, `120-136`.
- **UI-13** Tabs (`CatalogTabs`) shown when >1 catalog is registered or anything is disabled: "All",
  one per catalog in precedence order with a hue dot and entry count ("—" when skipped, struck
  through), and a far-right "disabled {n}" tab. Falls back to All when the disabled tab empties or the
  active catalog is unregistered, but not after a failed load. Plain buttons, no ARIA tab roles. Source: `components/CatalogTabs.vue:6-129`, `App.vue:379-426`; specs `App.spec.ts:59-130`.
- **UI-14** Catalog colour = hue by precedence position `[211, 275, 25, 320][(p−1) % 4]`, so
  reordering recolours. Source: `catalog.ts:38-43`.
- **UI-15** Catalog summary strip on a catalog tab: precedence, kind, write-mode text ("read-only" /
  "writes via pull request" / "writes directly"), location, skip reason; "Manage entries" only for
  editable catalogs. Source: `components/CatalogSummary.vue:20-64`.
- **UI-16** Counts line: "{filtered} of {rows} entries · {installed} installed[ · N disabled][ · N
  overridden]", computed over filtered rows; a disabled copy counts as installed and disabled. Source: `App.vue:436-457`; specs `App.spec.ts:334-361`.
- **UI-17** Empty states (three sentences): search matched nothing ("Nothing here matches **q**." +
  "Clear the search"); catalog tab empty ("{id} has no entries yet." + "Add the first one" if
  editable); nothing anywhere ("No catalog holds an entry yet. **Catalogs** above is where you add
  one."). Source: `App.vue:749-781`; specs `App.spec.ts:284-327`.
- **UI-18** Card: invisible full-card button opens the entry (`aria-label "Open {name}"`); type column;
  name; origin chip (multi-catalog); "pinned" pill; "overridden by {c}" pill; "overrides {a, b}";
  status badge; description; "requires: {raw refs}". Disabled cards are dashed and dimmed, tooltip
  "{status}\nParked at {archivePath}\n{SESSION_TIMING}". Source: `components/EntryList.vue:186-328`.
- **UI-19** Install badge (`installStatus`): considers only locations with a scope (project installs
  from elsewhere read "not installed"); mapping installed → "installed · scopes"; untracked →
  "installed by hand"; drifted → "edited locally" (attention); stale → "update available" (attention,
  **unreachable today**: the app never passes `--check-remote`, `desktop/src-tauri/src/cli.rs:944-946`);
  disabled → "disabled · scope"; missing → "installed, but gone from disk"; not_installed → "not
  installed". Source: `catalog.ts:180-232`; spec `catalog.spec.ts:336-390`, `953-1038`.
- **UI-20** Enable/disable switch: only for skills in state `installed` or `disabled`, not in selection
  mode; `role=switch`, `aria-checked`; optimistic (renders the requested state immediately, disabled
  for that row only while in flight); success → toast "{name} is switched on|off. Claude Code loads
  skills when a session starts, so this takes effect in your next session, not one you already have
  open." then reload; failure → switch snaps back, error toast "Could not switch {name}." with detail;
  `moved:false` counts as success. Rebuild: the switch writes `skillOverrides` (architecture §4.5); whether a
  change reaches an already-open Claude Code session is to be verified, so the "next session" copy may change. Source: `components/EntryList.vue:100-169`, `226-236`, `catalog.ts:164-165`;
  specs `EntryList.spec.ts:126-280`.
- **UI-21** Bulk selection (catalog tab only, when something is installable): "Install or remove
  several" → selection mode with "Select all {n}", "Clear", "Stop selecting"; overridden rows not
  selectable; when every row is overridden a note explains nothing can be installed. Selection is
  computed from the **search-filtered** rows. Source: `App.vue:159-166`, `675-737`; specs `App.spec.ts:413-436`.

### 4.4 Entry page (`components/EntryDetail.vue`, `InstalledCopies.vue`, `UninstallControl.vue`, `PushControl.vue`)

Tags: app/mvp/free

- **UI-22** Loads `entry_show {name, catalog}` on open and on catalog change; Busy "Reading {name}…";
  error banner; title from the prop so it renders before data. Header badges: type, catalog chip
  (multi), status badge, "guided setup available" (deferred cue). Source: `components/EntryDetail.vue:110-123`,
  `329-362`; specs `EntryDetail.spec.ts:85-99`.
- **UI-23** Disabled entry: "Switched off, so nothing loads it. {SESSION_TIMING}" + "Parked at {path}". Rebuild: no "Parked at" line, since nothing moves. Source: `components/EntryDetail.vue:366-369`; specs `EntryDetail.spec.ts:353-393`.
- **UI-24** Source card: raw path for local, else "{kind} · {org}/{repo} ({branch})" + file path. The
  app cannot show "local source missing" because `source.exists` is dropped in Rust. Source: `components/EntryDetail.vue:101-108`, `371-377`.
- **UI-25** "On this machine ({n})": one row per scope in `entry.scopes`, joined to that scope's
  receipt; "put here by hand — the tool has no record of it" without a receipt; "from {c}, not {subject}"
  when the receipt's catalog differs; per row "Send edits back" and "Remove", one panel open at a
  time. Empty: "Not installed anywhere yet. …". Source: `components/InstalledCopies.vue:37-125`,
  `catalog.ts:638-647`; specs `InstalledCopies.spec.ts`.
- **UI-26** Per-copy uninstall is two-step: "Delete the {scope} copy of {name}?" + dest + dependents
  that will be left incomplete + "The catalog entry is untouched…"; Delete sends `force:false`; a
  refusal becomes a **second** confirmation ("The tool has no install receipt for this path…"; "Leave
  it alone" / "Delete anyway" with `force:true`); force is never offered first. The "Removed …" success
  banner is effectively never seen (the page reloads and unmounts it). Source: `components/UninstallControl.vue:33-102`; specs `UninstallControl.spec.ts:36-161`.
- **UI-27** Push ("Send edits back"): dry run on open; shows the provenance `note` first; "Nothing to
  send — this copy already matches its source." when unchanged; else the diff (`<pre>`, max 18rem) or
  "Would overwrite {dest}" for a local source; a message field for PR sources (placeholder "library:
  updated {name}"); confirm "Push and open a pull request" | "Overwrite the source". Outcomes
  (`describePush`): "Nothing to push." / "Copied {name} back to its source." / "Pull request opened." +
  "View the pull request" / "Branch pushed — the pull request is not open yet." + "Open a pull request"
  (compare URL); it never says "opened" unless `method == gh`. Links open in the system browser. Source: `components/PushControl.vue:42-160`, `catalog.ts:669-705`; spec `catalog.spec.ts:895-951`.
- **UI-28** Install-and-set-up card → `EntryInstall` page. Source: `components/EntryDetail.vue:153-157`, `394-400`.
- **UI-29** Copies and pins: "Where this comes from ({n} catalogs)" or "Catalog holding this name";
  per copy: "pinned — this is what installs" / "first by catalog order — this is what installs" /
  "overridden by …"; actions "Clear pin" / "Pin to this" (winner) / "Use this one" (loser); "Edit this
  entry in {c}" only for editable catalogs. Source: `components/EntryDetail.vue:268-279`, `402-589`; specs
  `EntryDetail.spec.ts:251-337`.
- **UI-30** Pin is two-step with a reconcile preview: `entry_pin_preview` first; not switchable → pin
  immediately; else a proposal listing affected copies (`dest — state, from …`), new dependencies,
  dependents, blockers; buttons "Pin and switch the files over" (only when `simple`), "Pin only, leave
  the files", "Cancel". Apply = `entry_pin` then (if switching) `entry_use {names:[name]}` then reload;
  outcome banners "Switched {n} copies over to {c}…" or "The pin is saved, but the copies already
  installed were left alone: …". Source: `components/EntryDetail.vue:214-313`, `425-535`; specs
  `EntryDetail.spec.ts:149-236`.
- **UI-31** Dependencies: "Requires ({n})" (declared by the winning copy) and "Also installed, via
  those ({n})" (transitive), each opening that entry with a state pill (`state == installed`);
  "Required by ({n})" from `dependents` (pill uses `isOnDisk`, an inconsistency); "Unresolved ({n})"
  with reason text ("no catalog defines it" / "not a valid type:name reference" / "circular
  dependency") and "This entry will install without it." Source: `components/EntryDetail.vue:591-672`,
  `catalog.ts:266-310`.

### 4.5 Install (`components/EntryInstall.vue`, `InstallPreview.vue`, `BulkInstall.vue`)

Tags: app/mvp/free unless noted

- **UI-32** Source picker only when >1 catalog holds the name: options "{catalog} · default[, pinned]"
  (value "" → no `--catalog`) and the others; choosing a non-default reveals "Always use {source} for
  {name}…" which pins **before** installing (a pin failure aborts before any file is written). Source: `components/InstallPreview.vue:51-70`, `164-216`, `232-257`; specs `InstallPreview.spec.ts:91-168`.
- **UI-33** Scope radios "Globally" / "Into a project" with explanatory notes; project needs a
  directory (native picker, "Recent directories" max 3 in localStorage `library.recentProjects`). Source: `components/InstallPreview.vue:259-341`, `recentProjects.ts:1-41`. Tags: app/drop/free (project scope)
- **UI-34** Preview is **destination-level**: `entry_use_preview`, then one row per destination
  (requested + dependencies, "dependency" tag) with a state pill ("already installed" / "edited
  locally" / "installed by hand" / "installed, but gone from disk" / "new") and path; a scope line
  "{scope} · nothing has been written[ · installing the {c} copy, over {overrides}]". No per-file list
  exists before install. Source: `components/InstallPreview.vue:345-404`, `catalog.ts:770-823`.
  The MVP's "file-level preview" is therefore new work (architecture §3).
- **UI-35** Drift gate: if any destination (including dependencies) is `drifted`, the install button
  stays disabled until "Overwrite {n} locally edited copies, discarding those edits." is ticked;
  `untracked` and `missing` do not block (caution text only: "One copy was put there by hand…"). Source: `catalog.ts:585-601`, `731-761`, `components/InstallPreview.vue:388-402`; specs
  `catalog.spec.ts:292-334`, `InstallPreview.spec.ts:223`.
- **UI-36** Install button label: "Install globally" / "Reinstall globally" (all present) / "… into
  project". After install: "Installed {n} items." + per item `summarizeChanges` ("new install" / "1
  modified, 2 added, 1 removed" / "no changes") and file lines `~`/`+`/`-`; unverified warning
  "{names} landed, but the main file the catalog expects is not there…". Source: `components/InstallPreview.vue:406-451`, `catalog.ts:731-823`.
- **UI-37** Bulk panel: one preview for all ticked names (shared dependencies once), one drift
  acknowledgement, "Install {n} globally" (n counts dependencies); global only, no source picker;
  bulk "Uninstall" confirm ("Remove the global copies of {n} selected entries?" …), never forced;
  outcome banners incl. refusals ("… left in place because the tool has no record of installing
  them …"). Source: `components/BulkInstall.vue:86-315`; specs `BulkInstall.spec.ts:47-221`.

### 4.6 Sync (`components/Sync.vue`) and Doctor (`components/Doctor.vue`)

Tags: app/mvp/free

- **UI-38** Sync runs `catalog_sync {force:false}` on open; actions "Sync again", "Force re-fetch"
  (`force:true`), both disabled while running; Busy "Checking every installed entry against its
  source…"; summary "**{n} updated**" | "**Nothing changed**", "· {n} already up to date", "· {n}
  failed", "· {n} gone from disk"; "updated" = files touched, not `!up_to_date`; overwrite warning
  "{names} had local edits, which the refresh replaced…"; sections Failed (reason verbatim), Gone from
  disk (with "The record was kept and nothing was deleted…"), Updated (file lines), Also written
  (dependency writes with reason), collapsed "{n} entries unchanged". `synced` emitted only on success;
  a failure drops the report. Source: `components/Sync.vue:11-195`; specs `Sync.spec.ts:25-165`.
- **UI-39** Doctor ("Catalog health", reachable only from Catalogs): runs on open; "Deep checks
  (reaches the network)" checkbox re-runs (not disabled mid-run); "Re-run"; summary "{entries}
  entries · {errors} errors · {warnings} warnings" or "Nothing to report."; Errors and Warnings lists
  prefixed by subject (`entry ?? catalog`); no per-finding actions. Source: `components/Doctor.vue:11-87`;
  specs `Doctor.spec.ts:23-79`.

### 4.7 Catalogs, registration, authoring (`components/Catalogs.vue`, `RegisterCatalog.vue`, `AddEntry.vue`, `EntryEditor.vue`, `EntryRemove.vue`)

Tags: app/mvp/free unless noted

- **UI-40** Product rule: only catalogs with `kind == local && writable && !skipped` are editable from
  the UI (add/edit/remove entries); remote catalogs are never written from the app today. Source: `catalog.ts:326-339`, `468-471`. Tags: app/mvp?/free (mvp? because the decisions put add/update/
  remove with PR mode in MVP, which implies remote catalog writes the current UI deliberately avoids).
- **UI-41** Registry level: "Add a catalog", "Check catalog health"; a no-personal-catalog card when
  no local catalog exists ("You don't have a personal catalog yet" + "Create a personal catalog");
  catalog rows with location, note (`describeCatalog`), "Manage entries" (editable only), and
  "Unregister" (only when >1 catalog). Source: `components/Catalogs.vue:93-98`, `336-531`, `catalog.ts:361-379`;
  specs `Catalogs.spec.ts:41-109`.
- **UI-42** Pinned names block (`pins_list` on mount and on catalog change): "{name} → {catalog}",
  dangling text, "Clear" per row. Source: `components/Catalogs.vue:205-234`, `430-461`.
- **UI-43** Unregister is an inline confirm: "Stop reading from {id}?" + explanation; checkbox "Also
  delete the copies installed from it — around {n}…" (n is a UI estimate); for remote catalogs a
  checkbox to delete the clone; buttons "Unregister" / "Unregister and delete the copies". No in-flight
  guard (double-click can send twice). Result banner lists deleted paths, clone status, cleared
  receipts. Source: `components/Catalogs.vue:123-190`, `349-381`, `497-527`; specs `Catalogs.spec.ts:152-188`.
- **UI-44** Register: modes "Register an existing catalog" / "Create a new empty one" / "Add a shared
  repository"; id field (prefilled "personal" in create mode when free; duplicate ids blocked);
  local path chosen only via a directory picker; remote: clone URL + branch + "Changes go through a
  pull request" (default on; turning it off requires an explicit acknowledgement checkbox); "wins"
  (default on → registered first). "already exists" in create mode offers "Register the one that's
  there". Success banner states precedence ("checked first of {N} catalogs…") and any displacement. Source: `components/RegisterCatalog.vue:41-348`; specs `RegisterCatalog.spec.ts:32-83`.
- **UI-45** Catalog entries level: that catalog's entries sorted by name (`localeCompare`), each with
  "Edit" and "Remove" panels (one open at a time); arriving from an entry opens its Edit panel and
  scrolls it into view. Source: `components/Catalogs.vue:243-314`, `534-606`.
- **UI-46** Add entry: Name (autofocus), Type (default skill), Description, Source (+ "Choose file…"),
  Requires (checkboxes of this catalog's entries); live consequences: blocked duplicate in this
  catalog; "your copy takes precedence"; "would be added but never installed". Local paths trigger
  `source_suggestion`: global install dir → blocking error; project dir → caution; a derivable URL →
  "Use this URL" / "Keep the path"; else "No shareable URL for this file: {reason}…". Success banner
  "Added **{name}** to **{catalog}**, under {section}." + "Show in Finder" + commit/push lines. Source: `components/AddEntry.vue:81-381`, `catalog.ts:427-458`; specs `AddEntry.spec.ts:51-131`.
- **UI-47** Edit entry: name/type fixed (note explains); Description, Source, Requires; only changed
  fields are sent (`entryEdits`: trimmed, requires compared as a set); "Save changes" disabled when
  nothing changed; dismiss label "Cancel" with unsaved edits else "Done". Source: `components/EntryEditor.vue:46-165`,
  `catalog.ts:499-522`; specs `EntryEditor.spec.ts:32-55`.
- **UI-48** Remove entry: dry run on open showing dependents and the YAML diff; purge checkbox only
  when every installed scope is global ("Also delete the installed copies… the receipt check that
  normally refuses that does not apply here."); else instructions to remove installed copies first
  (pointing at a button label that does not exist). Source: `components/EntryRemove.vue:55-164`,
  `catalog.ts:546-553`.

### 4.8 Command log, activity, banners, toasts, appearance

Tags: app/mvp/free

- **UI-49** Command log (bottom bar): toggle "▸/▾ Commands {count}" (no `aria-expanded`); live
  activity label (`role=status`) = short argv of the running command, else the newest intent label;
  expanded list overlays upward (max `min(14rem, 60vh)`), newest first, status "…"/exit code
  (non-zero red), argv truncated at 160 chars with "full"/"less", duration "{n}ms"; empty "Nothing has
  run yet."; retained for the session, never trimmed or persisted; `cwd` received but not shown. Source: `components/CommandLog.vue:19-189`, `commandActivity.ts:18-151`; specs `CommandLog.spec.ts:30-143`,
  `commandActivity.spec.ts`.
- **UI-50** Activity bar: 2px indeterminate bar while any intent or command is pending; static under
  reduced motion. Source: `components/ActivityBar.vue:6-66`.
- **UI-51** StatusBanner is the single outcome surface: `role=alert` for errors, `status` otherwise,
  detail verbatim in `<pre>`; placed at the top of the surface that owns the command, never under the
  clicked control; not dismissible. Enforced by `statusFeedback.spec.ts:27-57`. Source: `components/StatusBanner.vue:2-66`.
- **UI-52** Toasts: bottom-right stack, success 4000 ms / error 6000 ms, hover holds and leaving
  restarts the full timer, dismiss button; used **only** by enable/disable. Source: `toasts.ts:34-71`,
  `components/Toasts.vue:10-159`; specs `toasts.spec.ts:14-76`.
- **UI-53** Appearance: System → Light → Dark cycle, stored in localStorage `library.appearance`
  (unknown → system), applied before mount, native window theme via Tauri `setTheme` so CSS follows
  `prefers-color-scheme`; button label "Appearance: {Current}. Switch to {Next}.". All colours are
  custom properties (`assets/tokens.css`); specs forbid colour literals and enforce 4.5:1 / 3:1
  contrast in both themes. Source: `theme.ts:4-36`, `components/AppearanceToggle.vue:13-47`,
  `assets/tokens.css:38-207`; specs `theme.spec.ts`, `AppearanceToggle.spec.ts`,
  `assets/contrast.spec.ts:72-131`, `assets/tokens.spec.ts:51-96`.
- **UI-54** Busy: `role=status` spinner with a contextual label (list of labels at
  `components/Busy.vue` call sites); reduced motion shows a static dot. Source: `components/Busy.vue:2-51`.
- **UI-55** PageHeader: optional "← {back}" where the label is the destination page's title; only
  PageHeader draws "←". Source: `components/PageHeader.vue:16-60`; spec `pageChrome.spec.ts:32-39`.
- **UI-56** Error text table (`describeAppError`): wrapper_missing / cli "library exited {code}.\n{stderr}"
  / ambiguous "More than one catalog can answer this: {a, b}. Pick one." (no picker exists) /
  not_bootstrapped / not_configured / json. Source: `types.ts:929-951`. Tags: incidental/drop/free

### 4.9 Deferred UI (documented, tagged later)

- **FirstRun.vue**: bootstrap then "Point it at your catalog" (repo, branch) → `catalog_init`. In v1
  the first-run need remains (no catalogs registered, or one-time import) but the bootstrap half is
  gone. Source: `components/FirstRun.vue:27-150`. Tags: app/later/free (import + first catalog: see
  architecture §4)
- **SetupReadiness.vue**, **Walkthrough.vue**, **SecretPrompt.vue**, `setup.ts`, `walkthrough.ts`:
  setup readiness card, agent walkthrough view (Enter sends, Shift+Enter newline), masked secret
  prompt. Source: `components/SetupReadiness.vue:103-270`, `components/Walkthrough.vue:57-248`,
  `components/SecretPrompt.vue:57-140`. Tags: app/later/free
- **demo/**: scripted README recordings over a fake IPC backend (`VITE_DEMO=1`). Source: `desktop/demo/README.md:1-182`, `desktop/vite.config.ts:12-41`. Tags: app/mvp?/free (mvp? because
  README GIFs are distribution, not product; keep only if the README keeps animated demos).

### 4.10 UI gaps observed (feed §7)

Success banners that unmount before they can be seen (UninstallControl, EntryRemove, EntryEditor,
InstallPreview after a non-default source); dependency pills using two different "installed" tests;
EntryRemove naming a non-existent button; no in-flight guard on Unregister; Doctor deep checkbox
re-runs mid-run; `entry_pin` mistyped as `Pin`; `UnpinReport.status` never sent; RegisterCatalog's
"a library.yaml or a directory" hint with a directory-only picker; "Hide overridden" shown on the
disabled tab; `installForOnDisk` reads the first copy rather than the winner; a11y gaps (unlabelled
search, no tab roles, no `aria-expanded`, inline confirms without focus handling). Sources: §4.3–4.8
citations; `components/EntryDetail.vue:600-646`, `components/EntryRemove.vue:147-148`,
`components/Catalogs.vue:149-170`, `components/Doctor.vue:47`, `components/InstallPreview.vue:173`,
`components/RegisterCatalog.vue:177-185`, `App.vue:313-318`, `666-672`.

## 5. Git and network inventory

### 5.1 Process environment and failure summarization

- `library.py:55-57` sets, at import, `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=<path of true>`
  unconditionally (a user's own values are overwritten) and `GIT_SSH_COMMAND="ssh -oBatchMode=yes"`
  only if unset. Because the env var outranks `core.sshCommand`, a gitconfig-level ssh command is
  silently replaced; `BatchMode=yes` also refuses unknown host keys. No `-c user.name/email` is ever
  passed, so every commit needs the user's git identity. No ssh `ConnectTimeout`. The env reaches
  every child, `gh` included. Tags: cli/mvp/free
- `_git_error_summary(stderr)` (`library.py:2195-2202`): first line starting `fatal:`/`remote:`/
  `error:`, else the last non-empty line, else `unknown error`. For ssh failures this drops the useful
  line (`Permission denied (publickey)`, `Host key verification failed.`) and keeps `fatal: Could not
  read from remote repository.`. Tags: cli/mvp/free
- `_git_in(work, cmd)` (`library.py:2879-2886`, spawns at `2881`): `git -C <work> <cmd…>`; non-zero
  raises `LibraryError("git <cmd> failed: <full stderr>")`. `_rev_parse` (`library.py:2392-2396`,
  spawns at `2394`): returns stdout or `None` (exit code is the only signal; git echoes the rev on
  failure).
- `main()` has no exception handler (ERR-02).
- The Rust layer runs **no** `git` or `gh`; it inherits whatever `library.py` does. Tags: incidental/drop/free

### 5.2 Every invocation

Columns: id, `file:line` (the spawning statement), exact argv, trigger, cwd, what it reads/mutates,
failure detection and surfacing, auth. "→" means the call goes through a helper that spawns at the
second line.

| # | file:line | argv | trigger | cwd | reads / mutates | failure → surfacing | auth |
|---|---|---|---|---|---|---|---|
| P1 | `library.py:474` | `node --version` | `setup` prerequisite `node` | inherited | — | rc≠0 → unmet "node not on PATH" | none |
| P2 | `library.py:1650` | `git -C <dir of main file> rev-parse --show-toplevel` | `suggest-source`; local-source refusal hints (`library.py:4890`, `4931`) | `-C` | user's local repo (read) | rc≠0 → reason `not inside a git repository` | none |
| P3 | `library.py:1655` | `git -C <repo root> remote get-url origin` | same | `-C` | local repo config | rc≠0 → `<root> has no 'origin' remote` | none |
| P4 | `library.py:1663` | `git -C <repo root> rev-parse --abbrev-ref HEAD` | same | `-C` | local HEAD | rc unchecked; empty → `main`; detached → `HEAD` | none |
| P5 | `library.py:2369` | `git clone --depth 1 --branch <b> <url> <tmp library-*>/repo`, url = ssh then https | `use`, `sync`, `pin`→`use` (`fetch_remote`) | inherited | network read; temp (clone cache) | per URL; last summary → `LibraryError("clone failed for <org>/<repo>: …")` → use `ERROR`, sync `failed[]` | SSH then HTTPS |
| P7 | `library.py:2409` → `2394` | `git -C <tmp>/repo rev-parse HEAD` | receipt `commit` | `-C` temp | temp | `None` recorded | none |
| P8 | `library.py:2410` → `2394` | `git -C <tmp>/repo rev-parse HEAD:<skill dir or file path>` | receipt `source_oid` | `-C` temp | temp | `None` recorded | none |
| P9 | `library.py:2434` | `git ls-remote <url> <branch>` (ssh then https) | `sync` skip test, `list --check-remote` | inherited | network read | rc≠0 or empty → next URL; all → `None` (memoized) | SSH then HTTPS |
| P10 | `library.py:2475` | `git clone --depth 1 --filter=blob:none --no-checkout --branch <b> <url> <tmp library-probe-*>/repo` | moved head in `sync` / `list --check-remote` | inherited | network read; temp (probe cache) | rc≠0 or no HEAD → rmtree, next URL; all → `None` (memoized) | SSH then HTTPS |
| P11 | `library.py:2480` → `2394` | `git -C <probe>/repo rev-parse HEAD` | probe success | `-C` probe | probe | `None` → attempt failed | none |
| P12 | `library.py:2492` → `2394` | `git -C <probe>/repo rev-parse <commit>:<path>` | `content_unmoved` | `-C` probe | probe trees | `None` → not provably unmoved | none |
| P13 | `library.py:2601` | `git clone --depth 1 --single-branch --branch <branch> <repo> <clone dir>` | any refresh with an absent clone; direct write; `catalog add`; `init` | inherited | network; creates persistent clone | **die** `could not clone catalog repo: … re-run library init` | configured URL only |
| P14 | `library.py:2616` | `git -C <clone dir> pull --ff-only` | every refresh; direct write; `catalog add` probe | `-C` clone | network; fast-forwards clone | warn `could not pull catalog repo (…); using cached copy` | URL in clone |
| P15 | `library.py:2647` | `git -C <clone dir> rev-list --count HEAD..origin/<branch>` | staleness (list, sync, doctor) | `-C` clone | refs (read) | any failure → 0 (silent) | none |
| P16 | `library.py:2904` | `git clone --single-branch --branch <branch> <repo> <tmp library-pr-*>/repo` (full history) | `add`/`remove`/`update` on a `pr` catalog, dry runs included | inherited | network; temp | die `failed to clone <repo> for write op: …` | configured URL |
| P17 | `library.py:2931` | `git -C <tmp>/repo push -u origin library/<op>-<name>-<ts>` | PR write; `push` of a remote source | `-C` temp | **mutates remote** (new branch) | keyword match → die `push rejected — you lack write access …`; else die `push failed: …` | URL used by the clone |
| P18 | `library.py:2985` | `gh pr create --repo <owner>/<repo> --base <base> --head <branch> --title <t> --body <b>` | after P17 iff `autopush` and host github.com | inherited | **opens PR** | rc 0 → `pr_url` = stdout; rc≠0 → die with last stderr line + compare URL; missing → die install hint | gh login |
| P19 | `library.py:3004` | `git -C <catalog dir> rev-parse --is-inside-work-tree` | local write with `git_commit` | `-C` | — | rc≠0 → warn, write without git | none |
| P20 | `library.py:3018` | `git -C <catalog dir> pull --ff-only` | local+git write (not dry run) | `-C` | network; ff user repo | warn `could not pull catalog '<id>' before writing …` | user repo remote |
| P21 | `library.py:3037` → `2881` | `git -C <work> add <yaml rel>` | local+git / direct write | `-C` | stages | warn `… written, but the commit failed`, `committed: false` | none |
| P22 | `library.py:3038` → `2881` | `git -C <work> commit -m <msg>` | same | `-C` | commits | same | git identity |
| P23 | `library.py:3046` → `2881` | `git -C <work> push` (local) / `git -C <clone> push origin HEAD:<branch>` (direct) | same | `-C` | **mutates remote branch** | warn `… committed, but the push failed`, `pushed: false`, exit 0 | that remote |
| P24 | `library.py:3131` → `2881` | `git -C <tmp>/repo checkout -b <branch>` | PR write | `-C` temp | temp | uncaught `LibraryError` → traceback, exit 1 | none |
| P25 | `library.py:3132` → `2881` | `git -C <tmp>/repo add <yaml_path>` | PR write | `-C` temp | temp | same | none |
| P26 | `library.py:3133` → `2881` | `git -C <tmp>/repo commit -m <msg>` | PR write | `-C` temp | temp | same | git identity |
| P27 | `library.py:3136` | `git -C <tmp>/repo show HEAD` | PR-mode dry run | `-C` temp | temp | rc ignored; stdout = diff | none |
| P28 | `library.py:5526` | `git clone --single-branch --branch <b> <url> <tmp library-push-*>/repo` (ssh then https, fresh temp each, full history) | `push` of a remote source (dry runs included) | inherited | network; temp | all fail → die `clone failed for <org>/<repo>: …` | SSH then HTTPS |
| P29 | `library.py:5549` → `2881` | `git -C <tmp>/repo checkout -b library/update-<name>-<ts>` | `push` | `-C` temp | temp | `LibraryError` → `ERROR` JSON, exit 1 | none |
| P30 | `library.py:5550` → `2881` | `git -C <tmp>/repo add <parent path or file path>` | `push` | `-C` temp | temp | same (fails for a root-level skill: empty pathspec) | none |
| P31 | `library.py:5552` | `git -C <tmp>/repo diff --cached --quiet` (stdio inherited) | `push` empty-diff check | `-C` temp | index | rc 0 → nothing to push; any other rc proceeds | none |
| P32 | `library.py:5573` → `2881` | `git -C <tmp>/repo commit -m <--message or "library: updated <name>">` | `push` | `-C` temp | temp | as P29 | git identity |
| P33 | `library.py:5576` | `git -C <tmp>/repo show HEAD` | `push --dry-run` | `-C` temp | temp | rc ignored | none |
| P34 | `library.py:5663` | `git ls-remote --heads <url> <branch>` (ssh then https; first rc 0 decides) | `doctor --deep`, per entry, unmemoized, no timeout | inherited | network | error `repo or branch unreachable: …` | SSH then HTTPS |
| P35 | `library.py:6407` | `git -C <clone dir> remote get-url origin` | `doctor`, per cloned remote | `-C` clone | config | rc≠0 → error; mismatch → warning | none |
| P36 | `library.py:6418` | `git ls-remote --heads <repo>` (timeout 15 s) | `doctor`, every remote, always | inherited | network | error `catalog repo unreachable` / `timed out` | configured URL |
| P37 | `library.py:6432` | `gh auth status` | `doctor` when any catalog is `pr` mode | inherited | gh state | warning (text claims a fallback that does not exist, §7) | gh |
| P38 | `library.py:6440` | `git -C <tool> fetch --dry-run` (timeout 10 s) | `doctor` tool staleness | `-C` tool clone | network, no ref update | `->` in stderr → warning; errors ignored | tool remote |
| P39 | `library.py:6706` | `git -C <tool>/.catalog-repo remote get-url origin` | `init` with an existing clone | `-C` | — | rc unchecked; mismatch or `--force` → rmtree | none |
| P40 | `library.py:6765` | `git -C <tool> pull --ff-only` | `self-update` | `-C` tool clone | network; ff tool | `{status: ERROR, message}` / die | tool remote |
| R1 | `desktop/src-tauri/src/path.rs:59` | `<python candidate> -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"` | `bootstrap_tool` | inherited | — | next candidate; none → `cli{-1}` | none |
| R2 | `desktop/src-tauri/src/path.rs:130` | `$SHELL -ilc "printf '\n__library_path__%s\n' \"$PATH\""` | app start (`lib.rs:420`) | inherited | sets process PATH | silent, fallbacks only; no timeout | none |
| R3 | `desktop/src-tauri/src/cli.rs:840` (spawned at `cli.rs:1681`) | `<library_home>/library <args…> --json`, env `LIBRARY_CWD` | every MVP Tauri command | **inherited** (no `current_dir`) | all P# | exit mapping (§3 preamble); stderr dropped on success | inherits |
| R4 | `desktop/src-tauri/src/cli.rs:1622` (spawned at `cli.rs:1681`) | `<python> <home>/bootstrap.py --json --dir <home>` | `bootstrap_tool` | inherited | `.venv`, pip (network) | `cli{code, problem or stderr}` | none |
| R5 | `desktop/src-tauri/src/agent.rs:128` (spawned at `agent.rs:644`) [deferred] | `claude -p <prompt> --output-format stream-json --verbose --mcp-config <f> --strict-mcp-config --settings <f> --disallowedTools ToolSearch --allowedTools <4 tools> --permission-mode dontAsk [--resume <id>]` | walkthrough start/say | `library_home()` | agent session | NotFound → `agent_missing`; else `agent_stream` | Claude login |
| R6 | `desktop/src-tauri/src/agent.rs:170` [deferred] | `claude --version` | `agent_available` | inherited | — | false on any failure (unlogged) | none |
| R7 | `desktop/src-tauri/src/mcp.rs:725` (output at `mcp.rs:748`) [deferred] | `<skill dir>/<program> <args…>` from a manifest `run` | MCP `run_skill_setup` | skill dir | skill's own effects | exit + output returned to the agent | none |

Not process spawns but network/IPC: `TcpListener::bind(127.0.0.1:0)` for the loopback MCP server
(`desktop/src-tauri/src/mcp.rs:150-151`, deferred); `openUrl` of PR/compare URLs
(`desktop/src/components/PushControl.vue:88`) and `revealItemInDir`
(`desktop/src/components/AddEntry.vue:255`). Tool scripts (`bootstrap.py:57`, `73`, `81`, `104`; 48
`justfile` recipes; `.githooks/pre-push:10-32`) are developer tooling (Tags: incidental/drop/free).

### 5.3 End-to-end sequences

**PR write** (`add`/`update`/`remove` on a protected remote; `library.py:3150-3188`, `3109-3147`,
`2896-2996`): P16 temp clone (full single-branch history) → read the catalog at `yaml_path` → edit →
verify → write → P24 `checkout -b library/<op>-<name>-<YYYYmmddTHHMM>` → P25 add → P26 commit (no
empty-diff check is needed: a no-op edit returns before any git) → dry run: P27 and stop → P17 push
the branch (always, whatever `autopush`) → compare URL (WRITE-10) → `autopush` false: `method:
manual`; true + GitHub: P18 `gh pr create` (die on failure, branch stays pushed); true + Bitbucket:
warn, manual → temp removed in `finally`. Branch names repeat within a minute, so a second identical
write in the same minute fails to push (observed). Tags: cli/mvp/contract

**Direct write** (`library.py:3053-3106`): P13/P14 on the persistent clone (even with `--no-pull`
and on a dry run) → edit the clone's file → P21/P22/P23 with `push origin HEAD:<branch>`; push
failure leaves an unpushed commit in the clone and later ff-only pulls fail forever once upstream
moves (RCAT-10). Tags: cli/mvp/free

**Local+git write**: P19 → P20 (not on dry run) → write → P21/P22/P23 plain `git push`. Tags: cli/mvp/free

**Push of a local copy to a remote source** (`library.py:5518-5622`): P28 → copy over → P29 → P30 →
P31 empty-diff check → P32 commit → dry run P33, else P17/P18 with `repo_url = clone_urls()[0]`
(the ssh form; the comment says HTTPS). The app runs this twice per push (preview clone + push clone).
Tags: cli/mvp/free

**Suggest-source** (`library.py:1630-1673`): P2 → P3 → `_remote_web` → P4 → relative path → browser
URL. Local only: nothing checks the file is committed or pushed, or that the branch exists remotely.
Tags: cli/mvp?/free (see §3.13)

**Doctor reachability**: P35 + P36 per remote (always), P37 when any catalog is `pr`, P38 for the tool,
then `pull_all` unless `--no-pull` (can die on an unclonable remote), P15 per remote; `--deep` adds P34
per remote-sourced entry. Tags: cli/mvp/free (P38 cli/drop/free)

**Self-update** (`library.py:6764-6779`): P40 only. "Tag drop" in the brief means "tag it `drop`";
no code creates, fetches or pins git tags (git-net reader; `git log --all` shows none). Tags: cli/drop/free

### 5.4 Where the code trades correctness for round trips

| # | Trade | Reason given | Citation |
|---|---|---|---|
| 1 | `ls-remote` memoized per repo+branch, failures included | "twenty skills from one repo is one round trip, not twenty" | `library.py:2424-2427` |
| 2 | `ls-remote <url> <branch>` is a tail match; first line wins (a `feature/main` branch or an annotated tag gives the wrong sha) | none (unintended) | `library.py:2434-2437` |
| 3 | One shallow clone per repo+branch per run | "36 entries from a single repository: 36 clones" | `library.py:2336-2345` |
| 4 | One blobless probe per repo+branch per run, failures memoized | "a failure is asked once per run rather than per entry" | `library.py:2445-2449` |
| 5 | Probe only after the head moved | "an unmoved head costs nothing extra" | `library.py:2500` |
| 6 | Receipt commit advanced when content is unmoved | "the next run is back on the free ls-remote path" | `library.py:2525-2527` |
| 7 | Staleness only under `--check-remote` | "a read command that silently hits the network hangs on a plane" | `library.py:3408-3412` |
| 8 | `sync` skips unchanged items unless `--force` | routine sync cheap and offline | `library.py:2517-2523`; `desktop/src-tauri/src/cli.rs:1044-1046` |
| 9 | `--no-pull`; app pulls only on launch/Refresh/Sync | 0.75 s of a 0.88 s `list` was the pull | `desktop/src/App.vue:226-232`; `desktop/src-tauri/src/cli.rs:940-943` |
| 10 | Pull failure tolerated | "stale cache is better than nothing for offline workflows" | `library.py:2589-2591` |
| 11 | Hydration never clones | "keeps load_config cheap and offline" | `library.py:986-988` |
| 12 | Pre-write pull non-fatal | "refusing to write … because a laptop is offline" is worse | `library.py:3014-3016` |
| 13 | `catalog_behind` uses the last-fetched ref, no fetch: reports 0 when upstream moved but nothing was fetched | "catches a failed ff-only pull … and stale --no-pull runs" (only partly true) | `library.py:2641-2643` |
| 14 | Shallow persistent catalog clones and shallow source clones; PR/push clones are full history | none stated (UNKNOWN: checked docstrings `library.py:2896-2901`, `5518-5536`, `docs/contributing.md`) | `library.py:2603`, `2370`, `2905`, `5527` |
| 15 | `catalog list` offline | inspection must not clone | `library.py:5821-5823` |
| 16 | Doctor timeouts 15 s / 10 s, errors swallowed | "offline or no git — not worth warning about" | `library.py:6420`, `6442`, `6447` |
| 17 | Fail-fast auth instead of prompting | never hang under an agent | `library.py:49-54` |
| 18 | Branch assumptions: suggest-source uses the current branch; doctor checks repo, not branch; pulls never check origin/branch | none | `library.py:1663-1664`, `6419`, `2616-2619` |
| 19 | `pin` → `use` with `no_pull=True` | avoid a second refresh | `library.py:3961` |
| 20 | Extra round trips kept: `use` always clones; `doctor --deep` unmemoized; direct mode pulls again after the refresh | — | `library.py:4100-4113`, `5660-5669`, `3069` |

UNKNOWN: whether a Finder-launched app inherits `SSH_AUTH_SOCK` and the user's credential helpers;
checked `desktop/src-tauri/src/path.rs:84-90` (only PATH is imported from the login shell); this
depends on launchd, not on this code. UNKNOWN: behaviour of a direct-mode push from a `--depth 1`
persistent clone against a real GitHub/Bitbucket remote; tests use local paths, where git ignores
`--depth` (`tests/test_library.py:543-546`).

## 6. App-only workarounds

Everything the Rust or Vue layer does because the CLI could not. "Native TS core?" answers whether a
UI-free TypeScript core using Tauri plugins makes the workaround unnecessary. Rust citations are under
`desktop/src-tauri/src/`.

| # | Workaround (where) | CLI limitation it compensates for | Native TS core? | Tags |
|---|---|---|---|---|
| W1 | **Compile-time tool root**: `library_home()` = `$LIBRARY_HOME`, else `env!("CARGO_MANIFEST_DIR")/../..`, else `.` (`cli.rs:804-820`); wrapper `<home>/library`, config `<home>/config.local.yaml` (`cli.rs:823-830`) | All device state lives beside `library.py` (`library.py:59-63`); the app must find that clone, so it is baked in at build time, which forces everyone to build from source (`desktop/README.md:162-167`) | Yes. State moves to the app data dir; nothing to locate | incidental/drop/free |
| W2 | **`LIBRARY_CWD` anchoring** on every call (tool root, or the picked project dir for `use`) (`cli.rs:832-843`, `966-974`) | Project-scope dirs resolve against `--cwd`/`$LIBRARY_CWD`/`os.getcwd()` (`library.py:1686-1715`); a GUI's cwd is arbitrary (`/` under Finder) | Yes. Global-only v1; a directory would be a typed argument if project scope returns | incidental/drop/free |
| W3 | **PATH widening** at startup: login-shell probe `$SHELL -ilc 'printf …$PATH'` + fallbacks `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`, `~/.cargo/bin`, appended (never prepended) (`path.rs:84-188`, `lib.rs:417-420`) | A Finder/launchd-launched bundle gets `/usr/bin:/bin:/usr/sbin:/sbin`; `gh` (Homebrew) and `claude` are not on it; the CLI spawns `git` and `gh` (`library.py:2370`, `2976`, `6432`) | **Partly.** Still needed for any external binary the core spawns (`git`, `gh`; `claude` later). See architecture §5 | app/mvp/free |
| W4 | **Python interpreter picker** for bootstrap (`path.rs:17-70`) | The CLI needs Python ≥ 3.9 + PyYAML; duplicates `library:39-48` and `bootstrap.py:29` | Yes | incidental/drop/free |
| W5 | **Bootstrap command + exit 3 → `not_bootstrapped`** (`cli.rs:1603-1651`, `1705-1712`) | PyYAML/venv dependency (`library.py:37-47`); exit 3 also means "no Python" (`library:53-57`), which the app conflates | Yes | incidental/drop/free |
| W6 | **`not_configured` inferred** from `config.local.yaml` absence after any failure (`cli.rs:920-936`) | A missing config is a plain-text `die` exit 1 (`library.py:1084-1088`) | Yes, a typed state | incidental/drop/free |
| W7 | **Exit-code tolerance** (`run_report` accepts exit 0/1 with a `status` body) + per-command status checks for use/toggle/sync/push/remove (`cli.rs:872-900`, `1027-1034`, `1139-1144`, `1054-1060`, `1334-1347`, `1304-1309`) | Exit 1 means both "report with problems" (doctor, sync PARTIAL, unverified use) and "ERROR body on stdout" (`library.py:6570`, `4796`, `4154`, `4116-4119`, `4482-4486`) | Yes, typed results | incidental/drop/free |
| W8 | **Exit-2 disambiguation**: `AMBIGUOUS_CATALOG` → `ambiguous` error kind; `REFUSED` → a report; setup `NOT_FOUND` → synthesized message (`cli.rs:1714-1722`, `1076-1113`; `setup.rs:186-189`) | Exit 2 is overloaded (`library.py:1202-1217`, `4390-4392`, `3555-3571`); NOT_FOUND has an empty stderr, so `show/use/uninstall/disable/enable` surface an **empty error message** in the app (gap) | Yes: discriminated result types; keep "ambiguous is a choice" and "refused is a report" | incidental/drop/free |
| W9 | **Refusal text extraction** from stdout `problems[]`/`reason`/`problem` (`cli.rs:1148-1175`, `1634-1646`) | Failure reasons go to stdout with an empty stderr (`library.py:4482`; `bootstrap.py:146`) | Yes | incidental/drop/free |
| W10 | **`--json` auto-appended** last (`cli.rs:841`) | CLI defaults to human text (`library.py:6791`) | Yes | incidental/drop/free |
| W11 | **Lenient serde mirrors** (unknown keys ignored, defaults, open-set strings) (`cli.rs:17-58`); side effect: `disabled`, `source.path/exists`, receipt `name/type/catalog_key`, top-level `locations` are dropped in transit (`cli.rs:86-105`, `167-183`, `209-218`, `236-246`, `758-777`) | App and CLI version independently; contract is "keys never change, new keys may appear" (`library.py:3424-3425`) | Yes: one codebase, shared types. Re-check the dropped fields as real requirements | incidental/drop/free |
| W12 | **Disjoint dry-run vs real shapes** so a lost `--dry-run` fails to parse (`would_install` vs `installed`; required `diff`/`would_change`) (`cli.rs:185-206`, `454-473`, `528-586`, `1351-1354`) | A boolean flag across a stringly argv can be lost; the CLI once shipped a push `--dry-run` that wrote (`library.py:2849-2852`, `5491-5493`) | Mostly: separate `plan()`/`apply()` functions; keep the invariant | incidental/mvp/free |
| W13 | **stderr warnings promoted** to payload keys (`dependents`, `note`) (`cli.rs:465-468`, `549-555`) | `warn()` writes stderr, which the app discards on success (`library.py:88-89`; `cli.rs:1730`) | Yes: structured warnings on every result | incidental/drop/free |
| W14 | **`--no-pull` only on `list`** (`cli.rs:939-949`) | Every read pulls by default (`library.py:1111-1121`); ~0.75 s of a 0.88 s list (`cli.rs:940-943`). Every other app command still pulls (gap vs `desktop/README.md:126-130`) | Yes: explicit fetch policy in the core | incidental/drop/free |
| W15 | **Always-explicit flags** (`--position first|last`, `update --catalog`, `push --from`, `--set-requires ""` to clear) (`cli.rs:1399-1406`, `513-516`, `1313-1318`, `1259-1263`) | CLI defaults and auto-detection that die or prompt (`library.py:6996-6997`, `5343-5345`, `5462-5463`) | Yes: typed parameters | incidental/drop/free |
| W16 | **Every command off the UI thread** via `spawn_blocking`, enforced by `tests/commands.rs` (`lib.rs:35-59`) | Each op blocks on a subprocess | Changes form: long synchronous JS (hashing, tree walks) must not block the webview; await plugin I/O, chunk CPU work | app/mvp/free |
| W17 | **Command log** events `command://started {id, argv, cwd}` / `command://finished {id, code, duration_ms}` (`events.rs`, `cli.rs:1661-1692`) | Not a CLI limitation: the transparency safeguard ("no per-action approval gate", `events.rs:1-5`) | No: keep, redefined as "every git/gh process the core spawns, plus every file the core writes or deletes" | app/mvp/free |
| W18 | **Client-side search** over the list payload; no `search` command (`lib.rs:61-65`) | A subprocess per keystroke is too slow | Yes: in-core filter function (same semantics as `fuzzy_candidates`) | app/mvp/free |
| W19 | **Error redaction** at the IPC boundary (`lib.rs:58`; `error.rs:64-94`) | CLI stderr is surfaced verbatim and could echo secrets | Deferred with secrets | app/later/free |
| W20 | **Direct file reads**: none on the MVP path (only `wrapper.exists()`, `config.is_file()`, `cli.rs:905`, `929`) | — | n/a | app/mvp/free |
| W21 | **No serialization in Rust**: concurrent app calls spawn concurrent CLIs; write safety is the CLI's `flock` + rename (`library.py:122-148`) | Three front doors share one state dir | No: the core needs its own write serialization (in-process queue per resource) | app/mvp/free |

Vue-side workarounds:

| # | Workaround (where) | Limitation it compensates for | Native TS core? | Tags |
|---|---|---|---|---|
| W-UI1 | **Domain logic re-derived in the UI**: winner grouping, install badge from `locations`, drift-blocking install plans, add consequences, edit diffing, purge eligibility, editable-catalog rule (`desktop/src/catalog.ts:54-136`, `180-232`, `427-458`, `499-553`, `585-601`) | CLI payloads answer per-command questions, not the view's (e.g. no "would this add be overridden?" query; `installed` vs `state` disagree, `library.py:3401-3407`) | Yes: these become core functions; only wording stays in Vue | app/mvp/free |
| W-UI2 | **Intent labels** (`withActivity`) shown before the backend's `command://started` arrives (`desktop/src/commandActivity.ts:39-53`, `113-117`) | IPC + process spawn latency leaves the activity bar blank | Partly: the core emits progress itself; a short intent label still helps | app/mvp/free |
| W-UI3 | **Reload after every write** (`load()` with `noPull`) and optimistic switch state (`desktop/src/App.vue:233-263`; `desktop/src/components/EntryList.vue:100-165`) | Write commands return no fresh entry records | Yes: writes return the updated records or emit change events | app/mvp/free |
| W-UI4 | **Browser-only mode** when Tauri is absent (`desktop/src/App.vue:221`, `510-521`) | Frontend runnable without the Rust backend | Yes: the in-memory fake `Library` serves dev and tests | incidental/drop/free |
| W-UI5 | **Recent project directories** (`desktop/src/recentProjects.ts:1-41`) | Project installs need a directory per call | Gone with project scope | app/drop/free |

## 7. Known gaps and discrepancies

### 7.1 Behaviors that look accidental (the rebuild must decide; none is fixed silently)

| # | Behavior | Evidence | Recommendation | Tags |
|---|---|---|---|---|
| A1 | `sync` reinstalls a disabled dependency into the active tree, leaving two copies (SYNC-07) | `library.py:4758-4778`; observed in sandbox | Moot in the rebuild (no archive; off skills stay in place) | cli/drop/free |
| A2 | `sync` overwrites untracked (hand-installed) copies whose name matches an entry (SYNC-03) | `library.py:4699-4701`, `2529-2530` | Fix by decision: unmanaged content is never overwritten without consent | cli/mvp/free |
| A3 | One unclonable registered remote makes every refreshing command, and doctor, exit 1 (RCAT-05) | `library.py:2599-2614`, `6450` | Fix: skip with a reason | cli/mvp/free |
| A4 | Direct-mode push failure leaves the persistent clone diverged forever (RCAT-10) | `library.py:3044-3050`, `2616-2623` | Fix: doctor detects, offers re-clone | cli/mvp/free |
| A5 | `ls-remote <url> <branch>` tail-matches (`feature/main`, tags) and takes the first line | `library.py:2434-2437`; experiment by git-net reader | Fix: `refs/heads/<branch>` | cli/mvp/free |
| A6 | `catalog_behind` reports 0 when offline (no fetch happened) | `library.py:2638-2657`; experiment | Fix: show "couldn't check" | cli/mvp/free |
| A7 | `verified` is vacuous (fallback to the destination itself) | `library.py:2571-2578`, `3301-3302`; observed | Fix or drop the field | cli/mvp/free |
| A8 | Root-level skill source copies the whole clone including `.git`; push of it fails on an empty pathspec | `library.py:2268-2274`, `2413`, `5543-5550`; experiment | Decide (FETCH-10); recommend refusing a root-level skill source | cli/mvp?/contract |
| A9 | A directory skill source installs its **parent** directory (FETCH-11) | `library.py:2327`, `2413` | Keep for compat; refuse on add | cli/mvp/contract |
| A10 | `update` drops unknown entry keys and in-entry comments; remove/replace eat blank lines below the item (EDIT-10/12) | `library.py:2788-2825`; tests `tests/test_library.py:913`, `981`, `1015`, `1057` | Replicate in v1 (byte compat), revisit with Python users | cli/mvp/contract |
| A11 | `requires` refs rendered without escaping (`"` inside a ref yields invalid YAML, then a parse-error traceback) | `library.py:2689-2690` | Validate refs on input | cli/mvp/contract |
| A12 | Inline `[ ]` sections and 2-space item lists make writes produce invalid YAML (rejected by verify, as a traceback) (EDIT-09) | probe in Appendix D | Return a typed `SPLICE_UNSUPPORTED` | cli/mvp/contract |
| A13 | Missing sections are never created (EDIT-05) | `library.py:2712-2713`; `tests/test_library.py:821` | Keep (compat); explain in the UI | cli/mvp/contract |
| A14 | Uncaught `LibraryError`s give tracebacks (ERR-02) | `library.py:4966`, `5362`, `5485`, `3131-3133`, `2786` | Moot: typed results | incidental/drop/free |
| A15 | PR branch names have minute resolution; a second identical write within the minute fails | `library.py:2891`; observed | Add seconds or a suffix | cli/mvp/free |
| A16 | `init` treats the first **remote** catalog as `shared` (wrong when a remote personal catalog precedes it) | `library.py:845-861`, `6705-6722`, `6736-6738` (code-derived, untested) | Moot: `init` dropped | cli/drop/free |
| A17 | A failed `init --force` restores the config but not the clone | `library.py:6705-6730`; observed | Moot | cli/drop/free |
| A18 | `catalog init <nonexistent path>` creates a file with exactly that name | `library.py:5967-5969`; observed | Decide: append `library.yaml` when the path has no `.yaml` suffix | cli/mvp/free |
| A19 | `catalog remove --purge-installs` deletes receipt destinations anywhere (incl. `--dir`, other projects) but strands archived copies | `library.py:6060-6075` | Fix: global only in v1 (archives are moot in the rebuild) | cli/mvp/free |
| A20 | `catalog add` reuses an existing clone dir for the id without checking its origin | `library.py:5880-5882`, `2598-2626` | Fix: check origin | cli/mvp/free |
| A21 | `catalog add` defaults a remote to unprotected (direct), while a config remote without the key defaults to protected | `library.py:5928-5931` vs `733` | Store `protected` explicitly; default the UI to PR (it already does) | cli/mvp/free |
| A22 | `bool()` coercion: quoted `"false"` reads as true for `writable`, `git_commit`, `protected`, `autopush` | `library.py:721`, `726`, `733`, `966` | Import: report and coerce strictly | cli/mvp/free |
| A23 | A non-mapping `default_dirs` crashes `default_dirs()`; mapping-shaped sections are silently ignored; unknown scope keys become extra scanned scopes | `library.py:1509-1515`, `1865` | Import: validate | cli/mvp/free |
| A24 | `pin` blocker for a receipt-only copy says "is a None install" | `library.py:3779-3780`, `3808-3812` | Moot (global only) | cli/drop/free |
| A25 | `doctor` calls an unknown-type ref `malformed`; `resolve_deps`/`show` call it `not_found` | `library.py:6310-6311` vs `2123-2125` | Pick one in the core | cli/mvp/free |
| A26 | `show.installs` lists receipts by name regardless of type | `library.py:3620-3621` | Filter by type | cli/mvp/free |
| A27 | `use` with several names reports `overrides`/`overridden_by` for the last name only | `library.py:4029`, `4078`, `4122` | Per-item provenance | cli/mvp/free |
| A28 | `push` updates no receipt, so a pushed copy keeps reading `drifted` | `library.py:5445-5622` | Update the receipt after a successful local push | cli/mvp/free |
| A29 | `resolve_deps` records a cycle with `required_by` = the re-entered node, not its parent (DEP-05) | `library.py:2112-2113` | Record the parent | cli/mvp/free |
| A30 | `_clone_repo` retries the https URL into the same directory without cleaning it | `library.py:2368-2378` | Fresh dir per attempt | cli/mvp/free |
| A31 | `_git_error_summary` drops the ssh reason line | `library.py:2195-2202`; experiment | Keep the last `ssh:`/`Permission denied` line too | cli/mvp/free |
| A32 | Receipt read-modify-write is not under the lock; catalog writes are not atomic (LOCK-02/03) | `library.py:284-286`, `3100` | Fix in the core | cli/mvp/free |
| A33 | `GLOBAL_DISABLED_DIR` is dead code; the "13 keys" comment describes a 14-key record | `library.py:68`, `3424` | n/a | cli/drop/free |
| A34 | `use --json` exits 0 with unverified items while human mode exits 1 | `library.py:4121-4127` vs `4154` | Moot | incidental/drop/free |

### 7.2 App-layer gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | NOT_FOUND/AMBIGUOUS for show/use/uninstall/disable/enable surfaces as an empty error message | `desktop/src-tauri/src/cli.rs:1698-1733`; only `setup.rs:186-189` handles it |
| G2 | Exit 3 conflates "no Python ≥ 3.9" with "no PyYAML"; bootstrap then fails | `library:53-57`, `desktop/src-tauri/src/cli.rs:1708-1712`, `1617-1620` |
| G3 | Every app command except `list` pulls every remote catalog (README claims reads are local) | `desktop/src-tauri/src/cli.rs:944-947` vs `desktop/README.md:126-130` |
| G4 | CLI warnings (pull failures, staleness, provenance) are discarded on success | `desktop/src-tauri/src/cli.rs:1730` |
| G5 | Fields dropped in transit: `disabled`, `source.path/exists`, receipt `name/type/catalog_key`, top-level `locations`, pin `holders`/`migrated` | `desktop/src-tauri/src/cli.rs:86-105`, `167-183`, `209-246`, `758-777`, `1547-1559` |
| G6 | "update available" badge unreachable (`--check-remote` never sent) | `desktop/src/catalog.ts:204-217`, `desktop/src-tauri/src/cli.rs:944-946` |
| G7 | No pre-install file-level preview | `desktop/src/components/InstallPreview.vue:345-404` |
| G8 | Success banners unmounted before they can be seen (uninstall, entry remove, edit saved, install after a non-default source) | §4.10 |
| G9 | No cancellation or timeouts on any CLI call; the login-shell PATH probe has no timeout | `desktop/src-tauri/src/cli.rs:1681`, `path.rs:119-141` |
| G10 | The loopback MCP server starts unconditionally and a bind failure aborts app startup | `desktop/src-tauri/src/lib.rs:442-450` |
| G11 | `security.csp` is `null` | `desktop/src-tauri/tauri.conf.json` (rust reader §4) |
| G12 | Ending a walkthrough leaves a running `claude` turn and a pending secret ask alive | `desktop/src-tauri/src/walkthrough.rs:161-173`, `secrets.rs:451-457` |

### 7.3 Docs vs code (code wins)

| # | Doc claim | Code | Severity |
|---|---|---|---|
| D1 | `--no-pull` exists only on list/show/search/use/uninstall/disable/enable/setup/sync/doctor (`SKILL.md:51`) | also on pin, add, remove, update, push (`library.py:6870`, `6926`, `6942`, `6961`, `6970`) | high |
| D2 | `--allow-local` = "allow a local source in a personal catalog" (`docs/commands.md:58`) | consulted only for **remote** destinations (`library.py:4973`, `5363`) | high |
| D3 | Exit 2 for an unknown name in remove/update/push (`docs/troubleshooting.md:44`, `SKILL.md:54`) | die, exit 1 (`library.py:5202-5203`, `5339-5340`, `5450-5451`) | high |
| D4 | Doctor: gh missing/unauthenticated → "autopush will fall back to compare URL" (`library.py:6434-6436`, `cookbook/doctor.md:63-65`) | `_create_pr` dies (`library.py:2984-2992`) | high |
| D5 | Disabled `use` skips deps and "`enable` brings them in" (`docs/workflows.md:40-41`, `cookbook/use.md:70-71`, `library.py:4040-4042`) | `enable` installs nothing (`library.py:4536-4672`) | high |
| D6 | `init --force` drops other catalogs (`cookbook/init.md:24-25`) | preserves them (`library.py:6613-6660`) | high |
| D7 | `sync` refreshes "every installed item (project + global)" (`cookbook/sync.md:8-9`) | once per name, first scope only (`library.py:4693-4706`) | high |
| D8 | "offer `default_add_catalog`" vs "never hand-edit config" (`cookbook/catalog.md:208-209` vs `6-8`) | no command writes `default_add_catalog` | high |
| D9 | `catalog remove` docs omit: refuses the only catalog; `--purge-installs` reaches anywhere and strands archives (`cookbook/catalog.md:123-156`) | `library.py:6090-6092`, `6060-6075` | high |
| D10 | Plain `doctor` is "a quick offline check" (`docs/troubleshooting.md:20`) | always `ls-remote`, `gh auth status`, `fetch --dry-run` (`library.py:6417-6447`) | medium |
| D11 | Exit 3 "means exactly this and nothing else" (`docs/troubleshooting.md:13`, `library.py:44-46`) | wrapper also exits 3 for no Python (`library:53-57`) | medium |
| D12 | Uninstall REFUSED JSON `{status, name, deleted, refused}` (`cookbook/uninstall.md:46-48`) | `{status, results: [...]}` (`library.py:4381-4392`) | medium |
| D13 | Provenance tracking "not done" (`docs/roadmap.md:60-72`) | receipts carry `catalog`/`catalog_key`; push warning is receipt-aware (`library.py:187-188`, `1307-1355`) | medium |
| D14 | Receipt example lacks `catalog_key`, envelope (`docs/reference.md:108-117`) | `library.py:187-188`, `242-244` | low |
| D15 | Path-scoped staleness handoff says "nothing implemented" (`specs/path-scoped-staleness/handoff.md:4`) | fully implemented (`library.py:2443-2556`, `3413-3422`) | medium |
| D16 | README "has the config schema" (`SKILL.md:15`, `19`) | schema is in `docs/reference.md:50-102` | low |
| D17 | "Default target is `.claude/skills/`" (`docs/concepts.md:58`) | default is global `~/.claude/skills/` | low |
| D18 | Push "opens a PR for GitHub sources" (`library.py:6965`) | Bitbucket sources take the same flow | low |
| D19 | `push` comment "Use HTTPS URL for the PR info" (`library.py:5591`) | passes the ssh URL (`library.py:5596`) | low |
| D20 | `desktop/README.md` "one spawn path" logged (`desktop/README.md:131-134`, `cli.rs:1661`) | three logging spawn paths, three unlogged spawns | medium |
| D21 | `desktop/README.md` walkthroughs need claude "signed in" (`desktop/README.md:70`, `153-154`) | only `claude --version` is checked | low (deferred) |
| D22 | Every error and path leaving the backend is redacted (`desktop/README.md:144-146`) | Ok payloads and `run_declared` argv are not | low (deferred) |
| D23 | `demo/README.md` aliases "four" Tauri modules | five (`desktop/vite.config.ts:12-18`) | low |
| D24 | EntryRemove points to a "Remove installed copies" button | button is labelled "Remove" (`desktop/src/components/InstalledCopies.vue:104`) | low |

The docs reader's full table (51 rows) is the source for this list; rows not repeated here are
cosmetic (stale line references in `specs/cli-app-support/*`, cookbook key tables missing new keys).

### 7.4 Fixtures vs code

The recorded payloads lag the code (programmatic key-set diff by the py-ops reader against a sandboxed
run): `list.json`, `show*.json` lack `locations`, `pinned`, `subject`, receipt `catalog_key` and
`source_oid`; `show-broken.json` also lacks `dependents` and has hand-edited `copies[0].requires`;
`use*.json` lack `requested` and per-item `disabled`; `sync*.json` lack `disabled`; reasons in
`use-error.json`, `sync.json` and the error in `doctor-problems.json` are not messages the code can
produce; `catalogs.json`'s skip path does not follow the code's clone layout; the stub's `catalog add`
emits `created` (only `catalog init` does); the stub's push `broken` returns JSON where the code dies.
No fixtures exist for pin, unpin, push, uninstall, enable/disable, registry add/remove, init. How the
non-setup payloads were recorded is UNKNOWN (no recording script; `list.json` was hand-edited with a
forward-compat probe key). Fixtures `setup-*.json` are recorded by
`desktop/src-tauri/tests/fixtures/record_setup_payloads.py`. Tags: incidental/drop/free

### 7.5 Roadmap items touching MVP behavior

| Item | Doc | Status |
|---|---|---|
| Per-catalog `autopush` | `docs/roadmap.md:13-23` | not implemented (global flag `library.py:787`); mvp? candidate for the new config |
| Catalog-qualified `requires` | `docs/roadmap.md:27-40` | not implemented; would change the catalog format (contract) |
| `copy`/`promote` | `docs/roadmap.md:44-56` | not implemented |
| Per-project catalog discovery | `docs/roadmap.md:76-87` | not implemented (project scope dropped) |
| Trust boundaries per catalog | `docs/roadmap.md:91-100` | not implemented |
| Text-splice fidelity (comment loss) | `docs/roadmap.md:104-132` | still true (EDIT-10/12) |
| `git_commit` in the write payload | `docs/roadmap.md:136-150` | still true |
| Two doctor `default_dirs` warnings | `docs/roadmap.md:154-169` | still two (`library.py:6262-6281`) |
| Catalog CI templates | `docs/roadmap.md:173-186` | none exist |

Open spec gaps (`specs/cli-app-support/tasks.md:255-256`): the losing copy reads as never installed in
`list` (RES-07), and `uninstall` cannot reach a receipt whose destination no longer resolves (UNIN-01).
Deferred there: `--progress-json` and receipts outside the tool dir (`tasks.md:264-266`); both are
answered by the rebuild. There are no TODO/FIXME/XXX/HACK markers in `library.py` or `desktop/`.

### 7.6 UNKNOWNs

- UNKNOWN: whether a Finder-launched app inherits `SSH_AUTH_SOCK` and credential helpers. Checked
  `desktop/src-tauri/src/path.rs:84-90`; depends on launchd.
- UNKNOWN: real-network behaviour of shallow persistent clones under direct-mode push, `gh pr create`
  stdout format, `doctor --deep`, and remote-source installs. Checked code paths `library.py:2355-2556`,
  `2914-2996`, `5518-5669`; tests use local bare repos where `--depth`/`--filter` are ignored
  (`tests/test_library.py:543-546`).
- UNKNOWN: why PR/push temp clones are full history while install/catalog clones are shallow. Checked
  docstrings `library.py:2896-2901`, `5518-5536`, `git log --oneline`, `docs/contributing.md`.
- UNKNOWN: which 13 keys the `entry_record` comment means. Checked `library.py:3423-3440`,
  `specs/cli-app-support/design.md:45`, `specs/cli-app-support/tasks.md:111`.
- UNKNOWN: how the non-setup fixture payloads were recorded (§7.4).
- UNKNOWN: contents of `desktop/specs/*` and the decision log referenced as D5/D15/D18/… in Vue
  comments and `progress.md` (`desktop/src/catalog.ts:333`). Not in this checkout.
- UNKNOWN: behaviour under concurrent invocations beyond what the lock code implies. Checked
  `library.py:122-148`, `236-287`; no concurrent receipt test exists.

### 7.7 Test gaps in the Python suite

Untested: `link`, `self-update`, `doctor --deep`, the SKILL.md variables migration, `autopush`/`gh`,
runtime ssh→https fallback, diverged clones, Bitbucket compare URLs, `_yaml_inline` directly,
`content_hash` digest values (never pinned), concurrent receipt writes. One test
(`tests/test_library.py:4145-4150`) attempts a real network clone. Source: Python-tests reader §7.

## Appendix A. Status strings and exit codes

### A.1 Top-level `status` values

| Value | Emitted at (`library.py`) | Meaning | Exit |
|---|---|---|---|
| `OK` | show 3629; pin 3860, 3895, 3923; unpin 3985; use 4079, 4123; setup 4212; uninstall 4390; disable 4522; enable 4662; sync 4714, 4793; suggest-source 5025; add 5180; remove 5270; update 5419, 5436; push 5508, 5566, 5600; link 5701; catalog add/init 5897; catalog remove 6111; catalog migrate 6153, 6181; doctor 6565; init 6734; self-update 6776 | success (`changed: false` possible) | 0 |
| `NOT_FOUND` | 3558, 4013, 4176, 4359, 4436, 4557 | exact name absent, no fuzzy candidates | 2 |
| `AMBIGUOUS` | 3558, 4013, 4176, 4359, 4436, 4557 | exact name absent, candidates listed | 2 |
| `AMBIGUOUS_CATALOG` | 1211 (via 5087, 5208, 5344) | write target or multi-held name needs `--catalog` | 2 |
| `REFUSED` | 4390 | uninstall met copies without receipts | 2 |
| `ERROR` | use 4116; disable 4482, 4496, 4512; enable 4625, 4639, 4652; push 5614; self-update 6771 | failure with a JSON body | 1 |
| `PARTIAL` | 4793 | sync finished with ≥ 1 failure | 1 |
| `DRY_RUN` | add 5167; remove 5247; update 5427; push 5497, 5563, 5582; catalog migrate 6170 | preview (`use`/`pin` dry runs use `OK` + `dry_run: true`) | 0 |
| `NONE` | 5025 | suggest-source found no URL | 0 |
| `PROBLEMS` | 6565 | doctor found ≥ 1 error | 1 |

Tags: cli/mvp/free (the core keeps the *meanings* as typed result variants; strings are free)

### A.2 Other enumerations

| Field | Values | Citation |
|---|---|---|
| install `state` | `not_installed`, `installed`, `drifted`, `untracked`, `disabled`, `missing`, `stale` | `library.py:1904-1927`, `3422` |
| write `mode` / `write_mode` | `local`, `pr`, `direct` | `library.py:1442-1451` |
| PR `method` | `manual`, `gh` | `library.py:2963`, `2987`, `2996` |
| catalog `kind` | `local`, `remote` | `library.py:724`, `729` |
| `source.kind` | `local`, `github`, `bitbucket`, `unknown` | `library.py:1601-1606`, `3537` |
| `unresolved_requires[].reason` | `cycle`, `malformed`, `not_found` | `library.py:2113`, `2119`, `2125` |
| `scope` | `global`, `project`, `null` (receipt-only location); uninstall `--scope all` | `library.py:78-80`, `2062`, `6881` |
| link `action` | `in-place`, `already-linked`, `created`, `repaired`, `repointed` | `library.py:5705-5727` |
| `_link_state` | `ok`, `missing`, `dangling`, `wrong-target`, `occupied` | `library.py:5675-5691` |
| setup prerequisite `kind` / secret `delivery` | `node`, `sibling-skill`, `env`, `binary`, `null` / `config-file`, `env`, `manual` | `library.py:295-296`, `487`, `567` |
| `catalog migrate` `reason` | `config is already in the catalogs form` | `library.py:6154` |
| dependency-write notes | `was gone from disk`, `was not installed`, `was disabled`, `local edits replaced`, `replaced a hand-installed copy` | `library.py:3263-3269` |
| state notes | `locally modified — will be overwritten` / `was locally modified — overwritten`; `not installed by this tool` / `was not installed by this tool`; `in the archive — still disabled` | `library.py:3243-3257` |
| human status words | `overridden by`, `stale (…)`, `installed (…)`, `not installed`; `Installed`/`Refreshed`; `up to date`/`refreshed`/`FAILED`/`also wrote`/`gone from disk`; `ERROR`/`WARN`; `[ok  ]`/`[MISS]`/`[  ? ]` | `library.py:3465-3469`, `4147`, `4814-4832`, `6577-6579`, `4256-4261` |

### A.3 Exit codes

| Code | Condition | Citation |
|---|---|---|
| 0 | success, no-op, dry run, `NONE`, doctor with warnings only, sync reporting `missing`, `use --json` with unverified items | every `return 0` (py-ops reader §10) |
| 1 | `die()` (every call site; none passes another code) | `library.py:92-94` |
| 1 | `use` item failure; `use` human mode with an unverified item | `library.py:4119`, `4154` |
| 1 | `disable`/`enable` refusals, mkdir failure, mid-batch move failure | `library.py:4486`, `4500`, `4517`, `4629`, `4643`, `4657` |
| 1 | `sync` `PARTIAL` | `library.py:4796`, `4842` |
| 1 | `push` `ERROR` | `library.py:5619` |
| 1 | `doctor` `PROBLEMS` | `library.py:6570`, `6581` |
| 1 | `self-update --json` failure | `library.py:6772` |
| 1 | uncaught exception (traceback) | ERR-02 |
| 2 | `AMBIGUOUS_CATALOG` | `library.py:1217` |
| 2 | `NOT_FOUND` / `AMBIGUOUS` | `library.py:3571`, `4026`, `4189`, `4372`, `4449`, `4570` |
| 2 | `uninstall` `REFUSED` | `library.py:4392`, `4408` |
| 2 | argparse usage error | argparse default (`library.py:6787-7030`) |
| 3 | PyYAML missing | `library.py:47` |
| 3 | no Python ≥ 3.9 (wrapper) | `library:56` |

Tags: incidental/drop/free

## Appendix B. Tauri command index

All in `desktop/src-tauri/src/lib.rs`, registered at `lib.rs:459-492`, every one `async` and run via
`spawn_blocking` (`lib.rs:44-59`).

| Command | lib.rs | CLI argv (all `+ --json`) | Section | Tags |
|---|---|---|---|---|
| `library_list` | 66-69 | `list [--no-pull]` | §3.1 | app/mvp/free |
| `entry_show` | 75-82 | `show <name> [--catalog <id>]` | §3.3 | app/mvp/free |
| `entry_use_preview` | 87-95 | `use <names…> [--project] [--catalog <id>] --dry-run` | §3.4 | app/mvp/free |
| `entry_use` | 100-108 | `use <names…> [--project] [--catalog <id>]` | §3.4 | app/mvp/free |
| `pins_list` | 111-114 | `pin` | §3.6 | app/mvp/free |
| `entry_pin_preview` | 117-124 | `pin <name> <catalog> --dry-run` | §3.6 | app/mvp/free |
| `entry_pin` | 130-137 | `pin <name> <catalog>` | §3.6 | app/mvp/free |
| `entry_unpin` | 140-143 | `unpin <name>` | §3.7 | app/mvp/free |
| `entry_uninstall` | 151-159 | `uninstall <names…> --scope <s> [--force]` | §3.8 | app/mvp/free |
| `entry_disable` | 164-170 | `disable <names…>` | §3.9 | app/mvp/free |
| `entry_enable` | 175-180 | `enable <names…>` | §3.9 | app/mvp/free |
| `catalog_sync` | 184-186 | `sync [--force]` | §3.11 | app/mvp/free |
| `entry_add` | 193-195 | `add --name --type --description --source [--requires] [--catalog]` | §3.12 | app/mvp/free |
| `entry_update` | 202-207 | `update <name> --catalog <c> [--set-description] [--set-source] [--set-requires]` | §3.15 | app/mvp/free |
| `entry_remove_preview` | 211-217 | `remove <name> --catalog <c> --dry-run` | §3.14 | app/mvp/free |
| `entry_remove` | 225-232 | `remove <name> --catalog <c> [--purge]` | §3.14 | app/mvp/free |
| `entry_push_preview` | 236-242 | `push <name> --from <from> --dry-run` | §3.16 | app/mvp/free |
| `entry_push` | 250-257 | `push <name> --from <from> [--message <m>]` | §3.16 | app/mvp/free |
| `source_suggestion` | 260-266 | `suggest-source <path>` | §3.13 | app/mvp?/free (mvp? because: see §3.13) |
| `catalog_doctor` | 269-272 | `doctor [--deep]` | §3.17 | app/mvp/free |
| `catalog_init` | 275-282 | `init --repo R --branch B` | §3.23 | app/later/free |
| `registry_add` | 285-291 | `catalog init …` or `catalog add …` | §3.19, §3.20 | app/mvp/free |
| `registry_remove` | 295-302 | `catalog remove <id> [--purge-clone] [--purge-installs]` | §3.21 | app/mvp/free |
| `registry_list` | 306-308 | `catalog list` | §3.18 | app/mvp/free |
| `entry_setup` | 315-317 | `setup <name>` | §3.5 | app/later/free |
| `submit_secret` | 325-340 | n/a (secret store) | §3.26 | app/later/free |
| `decline_secret` | 343-355 | — | §3.26 | app/later/free |
| `walkthrough_start` | 361-369 | n/a (`claude -p`) | §3.26 | app/later/free |
| `walkthrough_say` | 372-380 | — | §3.26 | app/later/free |
| `walkthrough_end` | 387-397 | — | §3.26 | app/later/free |
| `agent_available` | 404-407 | `claude --version` | §3.26 | app/later/free |
| `bootstrap_tool` | 410-413 | `<python> bootstrap.py --json --dir <home>` | §3.26 | incidental/drop/free |

Tests: `desktop/src-tauri/tests/cli.rs` (86 tests against the stub `tests/fixtures/toolroot/library`),
`tests/commands.rs` (3 structural guards: every command `async`, off the UI thread, registered).

## Appendix C. Component index

| Component | Section | Tags |
|---|---|---|
| `ActivityBar.vue` | UI-50 | app/mvp/free |
| `AddEntry.vue` | UI-46 | app/mvp/free |
| `AppearanceToggle.vue` | UI-53 | app/mvp/free |
| `BulkInstall.vue` | UI-37 | app/mvp/free |
| `Busy.vue` | UI-54 | app/mvp/free |
| `Catalogs.vue` | UI-41..43, UI-45 | app/mvp/free |
| `CatalogSummary.vue` | UI-15 | app/mvp/free |
| `CatalogTabs.vue` | UI-13 | app/mvp/free |
| `CommandLog.vue` | UI-49 | app/mvp/free |
| `Doctor.vue` | UI-39 | app/mvp/free |
| `EntryDetail.vue` | UI-22..31 | app/mvp/free |
| `EntryEditor.vue` | UI-47 | app/mvp/free |
| `EntryInstall.vue` | UI-28, UI-32..36 | app/mvp/free |
| `EntryList.vue` | UI-18..21 | app/mvp/free |
| `EntryRemove.vue` | UI-48 | app/mvp/free |
| `FirstRun.vue` | §4.9 | app/later/free |
| `InstalledCopies.vue` | UI-25 | app/mvp/free |
| `InstallPreview.vue` | UI-32..36 | app/mvp/free |
| `PageHeader.vue` | UI-55 | app/mvp/free |
| `PushControl.vue` | UI-27 | app/mvp/free |
| `RegisterCatalog.vue` | UI-44 | app/mvp/free |
| `SecretPrompt.vue` | §4.9 | app/later/free |
| `SetupReadiness.vue` | §4.9 | app/later/free |
| `StatusBanner.vue` | UI-51 | app/mvp/free |
| `Sync.vue` | UI-38 | app/mvp/free |
| `Toasts.vue` | UI-52 | app/mvp/free |
| `UninstallControl.vue` | UI-26 | app/mvp/free |
| `Walkthrough.vue` | §4.9 | app/later/free |

## Appendix D. Golden cases and the test-port plan

### D.1 Splice edge cases (run through `library.py` with PyYAML 6.0.3)

Each case below is input text → operation → exact output (`repr`) or error, produced by importing
`library.py` from the repo's `.venv` with bytecode writes disabled. Port each as a fixture.

| Case | Input | Op | Output |
|---|---|---|---|
| trailing comment on `library:` | `library:  # c\n  skills: []\n` | splice skill `beta` | `LibraryError: no 'library:' key in catalog` |
| missing section | `library:\n  agents: []\n` | splice skill | `LibraryError: section 'skills' not found under library` |
| `[ ]` with a space | `library:\n  skills: [ ]\n` | splice | `'library:\n  skills: [ ]\n    - name: beta\n      description: B\n      source: …\n'` (invalid YAML; WRITE-16 then fails) |
| quoted duplicate | `- name: "beta"` present | splice `beta` | `LibraryError: 'beta' already exists in skills` |
| 2-space items | `library:\n  skills:\n  - name: alpha\n…` | splice `beta` | 4-space block inserted **above** the 2-space items (invalid YAML) |
| case ordering | `alpha`, `Charlie` | splice `beta` | `alpha`, `beta`, `Charlie` |
| CRLF file | `library:\r\n  skills:\r\n    - name: alpha\r\n…` | splice `beta` | existing lines keep `\r\n`, new lines use `\n` |
| no trailing newline | file ends without `\n` | splice (append) | output ends without `\n` |
| top-level key after `library:` | `…\n\ndefault_dirs:\n  skills: []\n` | splice (append) | block inserted before the blank line; `default_dirs:` untouched |
| remove last item | `gamma` last in `skills`, blank line, `  agents: []` | remove `gamma` | blank separator removed |
| replace last item with an unknown key | `gamma` has `tags: [x]` | replace `gamma` | `tags` dropped, blank separator removed |
| collapse at EOF | `prompts` last, one item, file ends `\n` | remove it | `  prompts: []` with **no** trailing newline |
| requires with a quote | `requires: ['skill:a"b']` | render | `      requires: ["skill:a"b"]` (invalid YAML) |
| name needing quotes | name `yes` | render | `    - name: 'yes'` |

Plus the `_yaml_inline` observations in EDIT-02 (48 strings) as the seed of the scalar corpus. The
Python suite's verbatim splice goldens (`tests/test_library.py:549-1073`, the Python-tests reader's
§8.2 copies them) are the primary fixtures: `TestRenderEntry` (:630), `TestSpliceEntry` (:657),
`TestRemoveEntry` (:832), `TestReplaceEntry` (:940), `TestSpliceRoundTrip` (:1043), and through the
write seam `tests/test_library.py:8540`, `8693`, `9150`. Tags: cli/mvp/contract

### D.2 Python tests to port (from the Python-tests reader's classification; 880 tests, 99 classes)

| Priority | Port as | Classes (`tests/test_library.py:line`) |
|---|---|---|
| 1 | byte-exact golden | TestRenderEntry :630, TestSpliceEntry :657, TestRemoveEntry :832, TestReplaceEntry :940, TestSpliceRoundTrip :1043, TestApplyCatalogEdit splice/diff :8540, :8693 |
| 1 | value-exact golden | TestParseSource :1079, TestCloneUrls :1168, TestRemoteWeb :1184, TestDefaultDirs :1622, TestConfigValidation :3276 (exact problem strings, drives the importer), TestContentHash :3711 (+ a new digest golden computed in Python) |
| 2 | pure-logic unit | TestResolveDeps :1413, TestResolveDependents :1516, TestPrecedenceAndOverriding :4271, TestPins :4343, TestWriteTarget :8362, TestComputeUpdatedEntry :2078, TestHoldsCopy :1763, TestInstallDirMatch :1926, TestDisabledDir :2055, TestMoveTree :3649, TestDerivedInstallState :5511 |
| 2 | integration on the Node host (hermetic git) | TestOneClonePerRepoPerRun :2440, TestCatalogGitHelpers :3188, TestSyncSkipsUnchangedItems :5956, TestListCheckRemote :6436, TestUseAcrossCatalogs :5044, TestSyncAcrossCatalogs :5198, TestUninstall :7499, TestDisable :7733, TestEnable :7877, TestSyncKeepsDisabledEntriesDisabled :8062, TestUseOnADisabledEntry :8209, TestSyncReportsCopiesGoneFromDisk :6272, TestSyncNamesTheDependenciesItWrites :6383, TestAddTargetsACatalog :8756, TestUpdateTargetsACatalog :8924, TestRemoveTargetsACatalog :9040, TestDerivedAllowLocal :10100, TestSourceInsideAnInstallDir :9818, TestInstallWouldNotEatItsSource :1984, TestPinSwitch :4542, TestShow :7262, TestCatalogList :9173, TestCatalogAdd :9280, TestCatalogRemove :9477, TestCatalogInit :9677, TestDoctor* (:6661, :6776, :10312, :10429, :10574) |
| 3 | importer | TestConfigNormalization :2979, TestCatalogHydration :3092, TestCatalogModel :2874, TestCatalogMigrate :3417 (lifting), TestReinitPreservesTheRegistry :4167 (merge semantics) |
| drop | CLI-only | human-output goldens (:2214-2306, :4857, :4998), TestWriteReportShape :8703, `--cwd`/project scope (TestInstallDirAnchoring :1868, TestPushFromScopeNames :2704), setup manifests (:3775-:3948, :6905, :7204), init/bootstrap (:4086, :7222, `tests/test_bootstrap.py`), harness self-tests (:456, :524) |

Harness to reproduce in TS: a sandbox that injects every path (config, receipts, clones, home) and
asserts nothing escapes it (`tests/test_library.py:49-161`); local bare repos as remotes with a
per-repo git identity (`tests/test_library.py:164-215`); a URL seam instead of patching `clone_urls`
(`tests/test_library.py:2491`, `2644`, `5435`, `5997`, `6471`); `gh` stubbed at the process boundary
(`tests/test_library.py:229-245`); git protocol allowlist `file` (the one non-hermetic test,
`tests/test_library.py:4145-4150`). The Python suite passed (895 tests, 110 s) when run read-only by
the Python-tests reader.
