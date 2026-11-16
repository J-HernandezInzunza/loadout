# What Loadout relies on in Claude Code

A distilled reference: only what Loadout's code, a planned milestone or a ROADMAP entry depends on,
or a constraint Loadout must respect. Everything else Claude Code does is left out on purpose.

## 0. How to read this

**Source.** Claude Code's official docs at code.claude.com, read on 2026-11-14, when the latest
release was 2.1.325, plus its changelog. None of the read facts were run for this file.

**Marks.**

- A plain sentence with a citation is **read**: the docs say so. Citations are the page path and
  section, e.g. (/plugins/loading, Name conflicts). A fact found only in the changelog says
  "(changelog 2.1.323)".
- **Measured (S13)** means `spikes.md` has a run result, with the Claude Code version it ran on.
  Where a measured result and the docs differ, the measured result is what Loadout builds on.
- **Not documented** marks a gap Loadout depends on. Section 11 lists them with the spike each
  needs.

**Re-check on Claude Code upgrades.** Many facts are recent (2.1.309 to 2.1.325), and a measured
one holds for the version named. Doctor's version check (ROADMAP) can encode the minimums.

## 1. Where things load from

### 1.1 Locations

| Item | User (`~/.claude`) | Project | `--add-dir <dir>` | Plugin |
|---|---|---|---|---|
| Skill | `skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md`, start dir and parents up to the repo root | `<dir>/.claude/skills/` | `skills/`, as `/<plugin>:<name>` |
| Prompt (command) | `commands/<name>.md` | `.claude/commands/` | `<dir>/.claude/commands/` | `commands/` |
| Agent | `agents/*.md`, scanned recursively | `.claude/agents/`, walking up | `<dir>/.claude/agents/` | `agents/`, as `<plugin>:<name>` |

(/skills, Choose where skills load; /sub-agents, Choose the subagent scope; /permissions,
Additional directories grant file access, not configuration)

- **Skill names.** The docs say a skill's name is its frontmatter `name`, else its folder name
  (/skills, How a skill gets its command name). **Measured (S10, 2.1.312):** `skillOverrides` and
  the `init` list use the folder name. The changelog says the listing shows both names when they
  differ (changelog 2.1.290). Loadout installs to `skills/<entry name>/`, so the key is the entry
  name either way.
- **Prompt names** are the file name without `.md`; a subfolder becomes a `:` prefix
  (`commands/kit/x.md` is `/kit:x`). Prompts take the skill frontmatter except `name` and `paths`
  (/skills, Frontmatter reference). **Measured (S13, M9.08)** for a subfolder in an added dir.
- **Agent identity** is the frontmatter `name` only, not the file name. Two files with one `name` in
  one tree: one loads, by filesystem read order (/sub-agents, Choose the subagent scope).
- **Symlinks.** A skill entry in the personal or project location may be a symlink; a target that
  several locations point at loads once (/skills, Choose where skills load). **Measured (S15,
  2.1.323)** for skills, prompts and agents, including that `${CLAUDE_SKILL_DIR}` is the link's
  path, which the docs leave open.
- **Folders Claude Code owns inside `~/.claude/skills`.** `synced/` holds skills downloaded from a
  claude.ai account and `.trash/` what that sync removed; an authored skill named `synced`, or
  `anthropic-skills` and anything starting `anthropic-skills:`, does not load (/skills, Choose
  where skills load). A skill folder holding `.claude-plugin/plugin.json` loads as a plugin,
  `<name>@skills-dir`, with its agents, hooks and servers (same section). The scan must not read
  these as unmanaged skills, and an install must not create them by accident.
- **`CLAUDE_CONFIG_DIR`** moves the whole configuration directory. It is honoured from the shell,
  user settings or managed settings, and ignored in project and local settings (/env-vars;
  changelog 2.1.251). No variable moves only `skills/`, `agents/` or `commands/` (/env-vars).

### 1.2 Name clashes

| Same name in | Which one runs |
|---|---|
| Personal and project skill | Personal (/skills, Resolve skills that share a name) |
| User skill and a bundled skill or built-in command | The user's skill, but not the aliases; built-ins only in a local terminal session (same) |
| Skill and prompt | The skill (same). **Measured (S13)** with the skill in a loadout |
| Global skill and added-dir skill | Global keeps the name; the added one is `/<folder>:<name>` (same; changelog 2.1.309). **Measured (S13, 2.1.318)** |
| Two added dirs | The one added first; the other is prefixed (same) |
| Global prompt and added-dir prompt | Not documented. **Measured (S13):** the global one runs and the member can't be reached |
| Plugin skill and anything | Both load; the plugin's is `/<plugin>:<name>`, and its bare name also works unless taken (same) |
| Global agent and added-dir agent | Not documented. **Measured (S15):** the loadout's runs, with no prefixed twin |
| Two agents of one name across scopes | Managed, `--agents`, project, user, plugin, in that order (/sub-agents, Choose the subagent scope) |

**Measured (S15):** a loadout skill's prefixed name exists only while the global copy does; once
the global copy leaves, the member takes the bare name, at launch and mid-session.

### 1.3 What reloads live

| Change | Picked up | Source |
|---|---|---|
| `SKILL.md` added, edited or removed in `~/.claude/skills`, project skills, or an `--add-dir` passed at launch | Live | /skills, Edit a skill during a session |
| A top-level skills dir that didn't exist at start | Only after `/reload-skills` | same |
| `/add-dir` mid-session: are its skills watched? | Not documented | /skills, Load skills from a directory outside the project |
| Prompts in `~/.claude/commands` | Not documented. **Measured (S15):** about 2 s | |
| Prompts and agents in an added dir | Not watched: restart | /permissions, Additional directories grant file access |
| Agents in `~/.claude/agents` added or edited | Within a few seconds | /sub-agents, Write subagent files |
| Agent file deleted | Not documented. **Measured (S15):** gone within 6 s | |
| A new `agents` dir, or any session under `--disable-slash-commands` | Not watched | same |
| An invoked skill's text | Not re-read on later turns | /skills, Skill content lifecycle |

**Measured (S15):** a skill folder moved out of `~/.claude` leaves a running session in about 2 s,
and a skill in use loses its scripts; the model may still name an item it saw earlier.

## 2. Switching items on and off

### 2.1 `skillOverrides`

The switch arch §4.5 uses, and that M15 replaces for what Loadout installed.

| Value | Listed to Claude | In the `/` menu |
|---|---|---|
| `"on"`, or no key | Name and description | Yes |
| `"name-only"` | Name only | Yes |
| `"user-invocable-only"` | No | Yes |
| `"off"` | No | No; invoking it by name returns a `skillOverrides` error |

(/skills, Override skill visibility from settings; /settings-reference, `skillOverrides`)

- Any settings file may hold it; the `/skills` menu writes it to `.claude/settings.local.json`
  (/settings-reference, `skillOverrides`). `"off"` also hides the skill from command lists given
  to Remote Control clients and Agent SDK callers (/skills, Override skill visibility).
- **Plugin skills are not affected**, and `/skills` can't cycle them, nor a skill with an entry in
  managed settings or `--settings` (/skills; /commands, `/skills`).
- Keys match skill names only in user, project and local settings; in managed settings and
  `--settings` a key on a bundled skill's alias also applies (/skills, Override skill visibility).
- How it merges across files: not documented. **Measured (S7):** per key, local over project over
  user. **Measured (S13):** `--settings` merges per key too, and wins.
- Live: **measured (S8):** an open session refuses a skill turned off after it started.
- Prompts obey it: **measured (S9)**.
- An override is by name, so it hides a loadout's prefixed copy too: **measured (S13)**. This is why
  M15 switches installed items off by absence instead.

### 2.2 Deny rules for skills and agents

- `Skill` in `permissions.deny` stops all skills; `Skill(name)` one, and the deny also covers its
  aliases and a nested `dir:name` listing (/skills, Restrict Claude's skill access).
- `Agent(name)` in `permissions.deny`, or `--disallowedTools "Agent(name)"` for one session, stops
  Claude using an agent; `name` is the frontmatter `name` (/sub-agents, Disable specific subagents).
- Both are scoped rules: they block a call, and whether the item still sits in the listing Claude
  reads is **not documented** (/permissions, Manage permissions). Only frontmatter
  `disable-model-invocation: true` is documented as removing a skill from context.
- Rule lists merge across files, and "if a tool is denied at any level, no other level can allow
  it" (/permissions, Settings precedence). So a user-level deny can't be lifted in one project.
- No per-agent enable flag or `skillOverrides` counterpart exists (/sub-agents): hence deny rules
  in "Agents on and off", and absence in M15.

## 3. Composing one session

### 3.1 `--add-dir`

What `loadout run` passes today (M9).

| In the added dir | Loaded |
|---|---|
| `.claude/skills/` | Yes, watched when passed at launch |
| `.claude/commands/`, `.claude/agents/` | Yes, not watched |
| `.claude/settings*.json` | Only `enabledPlugins` (only `true` counts) and `extraKnownMarketplaces` (after that dir's own trust, changelog 2.1.319) |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/` (without `paths`) | Only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; `CLAUDE.local.md` also needs the `local` source |
| `AGENTS.md` | No |
| Hooks, MCP servers, output styles, other settings keys | No |

(/permissions, Additional directories grant file access, not configuration; /memory, Load from
additional directories, AGENTS.md)

- The flag takes space-separated paths (/cli-reference). **Measured (S13, M9.01):** the `=` form
  takes exactly one value; the docs don't promise that.
- Skills, prompts and agents from an added dir load through the `project` setting source
  (/permissions, same section). So `--setting-sources user` would drop a loadout (an inference).
- `permissions.additionalDirectories` in a settings file grants file access only and loads none of
  this; `/add-dir` mid-session loads the same as `--add-dir` (same section). `--bare` loads an
  added dir's skills but not its prompts or agents (/headless, Start faster with bare mode).
- Since 2.1.325 the sandbox refuses a session's sandboxed writes to `.claude` skills, agents,
  commands, settings and hooks in added dirs (changelog 2.1.325). Loadout writes from outside.
- **Measured (S13):** two sessions with different `--add-dir` folders don't mix. **Measured (S15):**
  in a loadout a copied skill's files read without a prompt; a linked one asks.

### 3.2 Other launch flags and variables

| Flag or variable | What it does for a loadout | Source |
|---|---|---|
| `--settings <file-or-json>` | Level 2 of 5, above local, below managed. Regular file, at most 2 MiB. Can't set `Managed` or `Global config` keys | /settings, Change a setting for one session |
| `--setting-sources user,project,local` | Chooses which layers load. Without `user`: no user skills, prompts, agents, plugins or settings, and no claude.ai skill sync. **Measured (S13)** | /cli-reference; /skills, Where synced skills load |
| `--mcp-config`, `--strict-mcp-config` | Servers for this session; see 7.1 | /cli-reference |
| `--plugin-dir <path>` | A plugin dir, a `.zip`, or a folder of plugins (v2.1.265+), as `<name>@inline`. Repeat per path. **Measured (S13):** every component is `<plugin>:<name>` | /plugins/cli-reference, Flags that load a plugin for one session |
| `CLAUDE_CODE_PLUGIN_DIRS` | Same, from the environment: absolute or `~` paths, `:` separated, v2.1.280+. Not settable from project or local settings | /plugins/create; /env-vars |
| `--agent <name>` | Main thread runs as that agent; overrides the `agent` setting; a custom agent replaces the system prompt; kept on resume | /cli-reference; /sub-agents |
| `--model`, `--permission-mode` | One value each for the session; not part of the settings stack | /settings, Settings precedence |
| `--session-id <uuid>` | Starts the session with that UUID | /cli-reference |

### 3.3 Resume

`claude --resume` and `--continue` do not restore `--add-dir` (nor a `/add-dir` folder),
`--settings`, `--mcp-config`, `--plugin-dir` or `--fallback-model`: "pass flags such as these
again". `--setting-sources` isn't in the list, which is open-ended (/sessions, Flags to pass again
when you resume). Restored: history, model, the `--agent`, and the permission mode in most routes
(/sessions, What a resumed session restores). A background session keeps its flags; resuming one
while it runs refuses flags such as `--settings` (/sessions).

`CLAUDE_CODE_RESUME_HINT_COMMAND` (v2.1.323): set by a wrapper to the name it is run as, it makes
the exit hint read `<name> --resume <session-id>`. The name must match `^\w[\w-]*$`, and the
variable is ignored in a settings `env` block (/env-vars; changelog 2.1.323). The VS Code extension
removes every `CLAUDE_CODE_RESUME_*` variable before it starts a session (/vs-code, Turn off
continuation after a reload). This backs ROADMAP "Resuming keeps the loadout".

### 3.4 Surfaces that take no flags

| Surface | Way in that is documented | Gap |
|---|---|---|
| VS Code panel | Runs its own bundled Claude Code. `claudeCode.claudeProcessWrapper` is the executable used to launch it, given the bundled binary's path. `claudeCode.environmentVariables` sets variables | No setting for extra arguments. Whether a wrapper may add flags, and whether `CLAUDE_CODE_PLUGIN_DIRS` works there: not documented |
| JetBrains | The plugin runs a **Claude command** in the IDE terminal | Whether that command may carry flags: not documented |
| Desktop, local | Saved environments hold folders and environment variables; **Add folder** mid-session | No flags. Whether an added folder loads `.claude/skills`: not documented |
| Background (`--bg`, `claude agents`) | Launch flags carry through, `/add-dir` folders too | |
| Agent-team teammates | `--settings` and `--setting-sources` | `--add-dir`, `--plugin-dir`, `--mcp-config`: not documented |

(/vs-code, Extension settings; /jetbrains, General settings; /desktop, Create a saved environment,
CLI flag equivalents, Add folders to a session; /agent-view, What carries over when you background;
/agent-teams)

- Settings files are shared by every local surface (/platforms). VS Code and Desktop run their own
  Claude Code copies, whose versions can differ from the terminal's (/vs-code; /desktop).
- A `claude` wrapper on `PATH` doesn't reach background sessions, which start from the binary's
  path (/corporate-launcher, What the launcher covers).

## 4. Settings files Loadout writes or reads

### 4.1 Files, precedence, merging

Highest first: managed (`/Library/Application Support/ClaudeCode/managed-settings.json` plus
`managed-settings.d/*.json`, the `com.anthropic.claudecode` plist, or server-managed), `--settings`,
`.claude/settings.local.json` (at the git repository root since 2.1.211, the main checkout's in a
worktree), `.claude/settings.json`, `~/.claude/settings.json`.

`~/.claude.json` is separate: account, MCP servers, per-project state such as trust (/settings,
Settings files and who they affect, Settings precedence).

- Lists such as `permissions.allow` and `hooks` merge across files; `env` merges per variable;
  `enabledPlugins` merges key by key; a same-named `extraKnownMarketplaces` entry is taken whole
  from the highest file (/settings, Lists merge instead of overriding; /settings-reference).
- Settings are strict JSON: a comment or trailing comma is a syntax error. A broken user, project or
  local file raises a dialog in an interactive session and is skipped silently in `-p`
  (/settings, Edit a settings file, Fix a broken settings file).
- If the user settings file isn't writable ("another tool generates it or links it to a read-only
  copy"), changes made in Claude Code last for the session only (/settings, A change you made in
  Claude Code is lost in new sessions). A sandbox clean-up deleted a symlinked `settings.json`
  before 2.1.247 (changelog 2.1.247).
- No command prints the effective merged settings or which file supplied a key; `/status` lists
  sources only (/settings, Confirm what loaded).

### 4.2 Live reload

Claude Code watches the settings files and applies most edits without a restart, including
`permissions` and `hooks`. `model`, `effortLevel` and `modelSettings` are read once at start. A
file created mid-session loads if its folder existed at start (/settings, When edits take effect).
`skillOverrides` isn't in the read-once list: **measured (S8)**.

### 4.3 Writing next to Claude Code

Claude Code writes these files too: `/config`, `/model`, `/effort`, `/fast` and the plugin options
dialog write `~/.claude/settings.json`; `/skills` writes `skillOverrides` and "don't ask again"
writes `permissions.allow` to `.claude/settings.local.json`; `/plugin` writes `enabledPlugins`;
removing a marketplace deletes its plugins' `enabledPlugins` entries; Claude Code may rewrite
`additionalMarketplaces` as `extraKnownMarketplaces` (/settings, Use the /config menu;
/settings-reference; /plugins/install).

- **Write races fixed late.** Before 2.1.323 a setting saved in a running session could undo a hand
  edit made moments earlier, and a deleted settings file could come back (changelog 2.1.323);
  before 2.1.319 an edit within a few seconds of a Claude Code write could be ignored (changelog
  2.1.319); before 2.1.317 edits in the first second after launch could be lost (changelog
  2.1.317). Overlapping VS Code writes could leave `settings.json` unparseable before 2.1.274
  (changelog 2.1.274). Arch §4.5 rule 2's re-read and compare is the guard on Loadout's side.
- **Locking.** Only `~/.claude.json` is documented as locked (`claude mcp add` waits for it,
  `CLAUDE_CODE_CONFIG_LOCK_WAIT_MS`, v2.1.318+). For `settings.json` and `settings.local.json` no
  lock, atomic-rename or merge-on-write contract is documented (/env-vars; /claude-directory).
- **Rewritten as read.** A mod's `settings.read` hook (v2.1.304+) can replace whole keys in the
  session's merged settings, in memory only; no file changes. It doesn't run for a user's mod where
  managed settings, `managed-mcp.json` or a Team or Enterprise login load the built-in guard.
  Which keys take effect this way is not documented (/plugins/mods/events, Change or refuse a
  settings read; /plugins/mods/admin). So the files Loadout edits may not be what a session uses.

### 4.4 Trust

In a folder not yet trusted, a repository's `permissions.allow`, `additionalDirectories`,
`extraKnownMarketplaces` and most `env` values wait; `deny` and `ask` apply at once. `-p` and SDK
runs never show the dialog and treat the folder as trusted for hooks, `env` and helpers
(/settings, A committed key doesn't reach teammates; /permissions, What runs before you trust a
folder). Trust is keyed on the git repository root (/permissions, Project allow rules and workspace
trust).

## 5. The skill list budget (M14)

- The listing Claude reads every turn holds every skill's name. When it overflows, descriptions are
  dropped, starting with the skills invoked least (/skills, Skill descriptions are cut short).
- Budget: 1% of the model's context window (`skillListingBudgetFraction`, any settings file, more
  than 0 and at most 1, default `0.01`), or a fixed character count in
  `SLASH_COMMAND_TOOL_CHAR_BUDGET` (fallback 8,000) (/settings-reference; /env-vars).
- Per entry, `description` plus `when_to_use` is cut at `skillListingMaxDescChars` (default 1,536)
  whatever the budget (/settings-reference, `skillListingMaxDescChars`).
- Not in the listing: `disable-model-invocation: true`, `"user-invocable-only"` and `"off"`.
  `"name-only"` keeps the name; the docs offer it to free budget (/skills, Override skill
  visibility from settings). A nested skill isn't listed until Claude touches a file there (/skills,
  Load skills in monorepos and subdirectories).
- Readings inside a session: the `/context` Skills row is the listing after the budget; `/doctor`
  estimates its cost and largest entries; an over-budget warning goes to the `--debug` log
  (/skills, Skill descriptions are cut short). The SDK's `getContextUsage()` returns tokens per
  skill (/agent-sdk/typescript, SDKContextUsage). The listing is rebuilt after compaction
  (changelog 2.1.304).
- **Not documented**, each for S14: how the 1% becomes characters, the order of entries, what
  "invoked least" counts and where that history is kept, whether plugin, bundled and synced skills
  and prompts share the budget (the variable's name suggests prompts do), and whether a description
  is cut or dropped whole.

## 6. Plugins and marketplaces

Only what "See what plugins add", "Part of a plugin in a loadout", "A catalog as a plugin
marketplace", "Share as a plugin" and "Evidence that a skill triggers" need.

### 6.1 Identity, enabling, reload

- Every plugin is `<name>@<origin>`: `@<marketplace>`, `@inline` (`--plugin-dir`, `--plugin-url`,
  `CLAUDE_CODE_PLUGIN_DIRS`, SDK `plugins`), `@skills-dir`, `@synced`, and `@builtin` (not in
  `claude plugin list`) (/plugins/loading, Find where a plugin came from; /plugins/cli-reference).
- `enabledPlugins` maps `<entry name>@<marketplace>` to a Boolean, in any settings file
  (/settings-reference, `enabledPlugins`). A version-list value appears only in a changelog fix
  (changelog 2.1.323). Precedence, lowest first: an added dir (only `true`), user, project, local,
  `--settings`, managed (`false` blocks, `true` forces) (/plugins/loading, Find where a plugin is
  enabled). A project `true` beats a user `false`; opt out in `.claude/settings.local.json`
  (/settings-reference).
- A plugin is declared in settings, fetched under `~/.claude/plugins`, then loaded. Changes reach a
  session only after `/reload-plugins` or a new session (/plugins/loading, Check which stage a
  plugin reached).
- Names: skills `/<plugin>:<name>`, agents `<plugin>:<name>`, MCP servers `plugin:<plugin>:<server>`
  with tools `mcp__plugin_<plugin>_<server>__<tool>` (/skills; /sub-agents; /plugins/components).
- No switch for one skill, agent, hook or server inside an enabled plugin; the options are the
  whole plugin (/plugins/measure, Lower the always-on figure).

### 6.2 Session-only replacement

A session-only plugin with the same **manifest name** as an installed one replaces it, whole, for
that session. Against a marketplace plugin this is silent: `claude plugin list` still shows the
installed one enabled, and only the `--debug` log records it. The installed copy loads instead
when `<name>@inline` is set to `false` or managed settings lock the name (/plugins/loading, Name
conflicts; /plugins/cli-reference). Which saved options and data directory the copy uses is not
documented.

### 6.3 Marketplaces, sources, pinning

- A marketplace is `.claude-plugin/marketplace.json` with `name`, `owner` and `plugins`. Unknown
  keys are ignored, and each entry is validated on its own (/plugins/marketplace-reference,
  Marketplace file).
- Plugin sources: a relative path, `github` (`repo`, `ref`, `sha`), `url` (`url`, `ref`, `sha`),
  `git-subdir` (`url`, `path`, `ref`, `sha`; sparse checkout of that path), `npm`, `archive`
  (`url`, `sha256`). `sha` is a full 40-character commit; with `ref` and `sha` both set, `sha` is
  checked out (/plugins/marketplace-reference, Plugin sources). A marketplace's own `ref` may be a
  full SHA from 2.1.324 (same).
- Version: `plugin.json` `version`, then the entry's, then a 12-character commit SHA for git
  sources. A pinned `version` string keeps users on the cached copy until it changes
  (/plugins/loading, How Claude Code computes the version).
- Private sources use the machine's own git credentials; there is no token field
  (/plugins/host-marketplace).

### 6.4 `validate`, `details`, `list`, `eval`

| Command | Input | Output |
|---|---|---|
| `claude plugin validate <path>` | A manifest, a plugin dir, or with no manifest a dir named `skills`, `agents`, `commands` or `.claude` (v2.1.233+). Symlinks are not followed; a root `SKILL.md` is not checked | Exit 0, 1 or 2; `--json` with `success`, `target`, `manifest`, `contents[]` of `file`, `errors`, `warnings` |
| `claude plugin details <name>` | A loaded plugin; for a folder, `claude --plugin-dir <dir> plugin details <name>` | Text only: component inventory and an always-on token figure |
| `claude plugin list --json` | none | One object per install: `id`, `version`, `scope`, `enabled` (merged settings, not loaded), `installPath`, `errors` |
| `claude plugin eval [target]` | A plugin with a manifest, or a skills-dir plugin. Cases in `evals/<case>/prompt.md` with `graders/` | `aggregate-result.json` (scores, `claudeVersion`), `report.html`; exit 0, 1, 2, 130, 143 |

(/plugins/cli-reference, plugin validate, plugin details, plugin list, plugin eval; /plugin-evals)

- `eval init` accepts a loose skill folder; whether `eval` then runs on one is not documented.
- A `tool_used` grader on `Skill` measures triggering. Each run has a temporary home with only the
  plugin under test, so the skill triggers alone, not among a user's other skills.
- Every run is a real model call: about cases times runs, twice (with and without the plugin).
  Non-TTY or `--json` runs need `--trust-plugin` (/plugin-evals).

## 7. MCP servers and hooks

For "MCP servers, hooks and settings in a loadout" and "Servers, hooks and rules as catalog
entries".

### 7.1 MCP servers

- Entries sit under an `mcpServers` map, in one format for `~/.claude.json`, `.mcp.json` and
  `managed-mcp.json`; there is no published schema (/mcp-quickstart, Edit .mcp.json directly;
  /managed-mcp). Fields seen: `type`, `command`, `args`, `env`, `url`, `headers`, `headersHelper`,
  `oauth`, `timeout`, `alwaysLoad` (/mcp).
- `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and `headers`. An unset
  variable with no default stays literal, with a warning. Claude Code's own and other credential
  variables read as empty in a remote server's `url` and `headers`, and a default on them is
  ignored; the full list isn't published (/mcp, Environment variable expansion, Credential
  variables that read as empty).
- `--mcp-config` takes JSON files or strings. A failing entry is skipped and named in the `init`
  message's `mcp_server_errors` (/cli-reference; /headless). `--strict-mcp-config` skips servers
  from `.mcp.json`, `~/.claude.json` and plugins; it doesn't bypass `allowedMcpServers` or
  `deniedMcpServers` (/managed-mcp). With a `managed-mcp.json` deployed, either flag makes the
  session exit at start (same).
- Approval: only project `.mcp.json` servers are documented as asking, and `-p` and SDK runs connect
  them without asking (/mcp, Project scope). The file passed to `--mcp-config` is a protected path
  for the session (/permission-modes, Protected paths).
- Precedence for one name: local, project, user, plugin, claude.ai connectors; the winning entry is
  used whole (/mcp, Scope hierarchy and precedence). Edits to `.mcp.json` take effect after a
  restart (/mcp-quickstart).

### 7.2 Hooks

- User and project hooks live only under the `hooks` key of a settings file; there is no standalone
  hooks file outside plugins (/debug-your-config, Check hooks). Frontmatter hooks in a skill run
  from its invocation to the session's end; in an agent, while it runs (/hooks, Hook locations).
- Hook entries merge across settings levels, and one handler defined in several files runs once
  (/hooks, Hook locations, Hook handler fields). Neither sentence names `--settings`; telemetry
  lists `flagSettings` as a hook source (/monitoring-usage, Hook registered event).
- An interactive session holds back hooks from every settings file until the folder, or a parent
  that covers it, is trusted; `-p` and SDK runs treat the folder as trusted (/hooks, Workspace
  trust). Whether `--settings` hooks wait for trust: not documented.
- `--bare` runs no hooks, even from `--settings` (/headless). `--settings
  '{"disableAllHooks": true}'` turns user, project, local and plugin hooks off for one run (/hooks,
  Disable or remove hooks).
- No individual hook can be switched off while kept in the configuration (same).
- Plugin hooks, monitors and servers run outside the sandbox with the user's privileges
  (/plugins/security). Arch must treat a hook entry as code that runs unasked.

## 8. Organisation lock-downs that break Loadout

| Managed key | What it stops for Loadout | Source |
|---|---|---|
| `strictPluginOnlyCustomization` (`true`, or an array of `skills`, `agents`, `hooks`, `mcp`) | `skills`: everything in `~/.claude/skills` and `commands`, project ones, and `--add-dir` skills and prompts. `agents`: user, project and `--add-dir` agents. `hooks`: settings hooks and frontmatter hooks. `mcp`: `~/.claude.json` and `.mcp.json` servers. Any lock also stops skills-dir plugins. An invalid value locks all four | /settings-reference, `strictPluginOnlyCustomization`; /managed-settings, Keys that fail closed |
| `disableSideloadFlags` | `--plugin-dir`, `--plugin-url`, `--agents`, `--mcp-config` (unless every server is `type: "sdk"`), `CLAUDE_CODE_PLUGIN_DIRS`: Claude Code exits with an error. Not named: `--add-dir`, `--settings`, `--setting-sources`, `--agent` | /settings-reference, `disableSideloadFlags` |
| `allowManagedHooksOnly` | User, project, local and plugin hooks, except plugins force-enabled by managed `enabledPlugins` | /settings-reference |
| `allowManagedPermissionRulesOnly` | `allow`, `ask`, `deny` in user, project, local and `--settings` files; `allowed-tools` of skills in `~/.claude` and `--add-dir` | /settings-reference |
| `strictKnownMarketplaces`, `blockedMarketplaces` | Marketplaces outside the allowlist (`[]` blocks all). Any allowlist without `{ "source": "skills-dir" }` stops skills-dir plugins. Matching is exact, `ref` included. `--plugin-dir` isn't blocked | /plugins/org, Allowlist with strictKnownMarketplaces |
| Managed `enabledPlugins` | `false` blocks a plugin at every scope; `true` forces it | /settings-reference, `enabledPlugins` |
| Managed `skillOverrides` | Outranks the user's entry for that name | /settings, Settings precedence |
| `managed-mcp.json`, `allowManagedMcpServersOnly`, `deniedMcpServers` | `--mcp-config` exits, or its servers are filtered | /managed-mcp |

- An unreadable managed value is enforced as its strictest; an unparseable managed file stops
  Claude Code from starting (/managed-settings, Keys that fail closed; changelog 2.1.259).
- `/status` lists setting sources, with `Skipped sources` (v2.1.242+); `claude doctor` has an
  `Organization policy` line (v2.1.261+) (/managed-settings, Read the source in /status; changelog
  2.1.261). Server-managed settings are cached at `~/.claude/remote-settings.json`
  (/server-managed-settings).
- Plugin skills, agents and servers survive every `strictPluginOnlyCustomization` lock
  (/settings-reference), which is what "A catalog as a plugin marketplace" offers.

## 9. Run modes

| Mode | Sees | Takes flags |
|---|---|---|
| Cloud session | A fresh clone: committed `CLAUDE.md`, rules, skills, agents, prompts; hooks, permission rules and `.mcp.json` with one repository only; not plugins the repo declares; nothing from `~/.claude`; claude.ai account skills; server-managed settings | No |
| `claude -p` | The same discovery as an interactive session, with no trust dialog | All |
| GitHub Action | `CLAUDE.md` and `.claude/skills` after checkout; the rest not documented | `claude_args` takes any CLI argument |
| Agent SDK | `settingSources` omitted means user, project, local (Python drops local when `skills` is set) | Through options |

(/cloud-environments, What carries over from your setup; /settings, Settings in cloud sessions;
/headless; /github-actions, Action parameters; /agent-sdk/claude-code-features)

- A cloud setup script may write `~/.claude/CLAUDE.md`; skills or settings there: not documented
  (/cloud-environments, Add personal preferences without committing to the repo).
- `-p`: `--bare` skips discovery and "will become the default for `-p` in a future release"
  (/headless, Start faster with bare mode). Under `--bare` an added dir's prompts and agents don't
  load, so `loadout run <name> -p` would lose them. `-p` starts in Manual permission mode since
  2.1.302 (/headless).
- The `init` message of `-p --output-format stream-json --verbose` lists `skills`,
  `slash_commands`, `agents`, `plugins`, `mcp_servers` and their errors (/headless). **Measured
  (S7 to S15):** it reflects overrides and clashes, which made it the spikes' probe and backs
  "Explain a launch".
- GitHub Action inputs: `plugins` (newline-separated `<name>@<marketplace>`, the marketplace's
  manifest name), `plugin_marketplaces` (newline-separated git URLs), `settings` (JSON string or
  path; merging not documented) (/github-actions, Action parameters).

## 10. Usage signals

For "Usage" under "Knowing what a session will load".

| Source | Gives | Limits |
|---|---|---|
| `UserPromptExpansion` hook | A typed command: `command_name`, `command_args`, `command_source`, `expansion_type`, with `session_id` and `cwd` | `command_source` values not listed; doesn't fire when Claude invokes a skill (/hooks, UserPromptExpansion) |
| `PreToolUse` / `PostToolUse` on `Skill` | Claude's own skill calls | The `tool_input` field holding the skill's name is not documented; `Skill(skill:<name>)` in /permissions implies `skill` (/hooks; /permissions) |
| `SubagentStart` | `agent_type`, the frontmatter `name` | (/hooks, SubagentStart) |
| `claude_code.skill_activated` (OpenTelemetry) | `skill.name`, `invocation_trigger` (`user-slash`, `claude-proactive`, `nested-skill`), `skill.source` | A user's skill is `custom_skill` unless `OTEL_LOG_TOOL_DETAILS=1`. No file exporter: `otlp` needs a receiver, `console` writes to stdout (/monitoring-usage, Skill activated event; /agent-sdk/observability) |
| Transcripts | `~/.claude/projects/<project>/<session-id>.jsonl`, kept 30 days (`cleanupPeriodDays`) | "Internal to Claude Code and changes between versions" (/sessions, Where transcripts are stored) |

- The docs recommend `skill_activated` with `OTEL_LOG_TOOL_DETAILS=1` for finding unused skills
  (/large-codebases, Keep skills discoverable). Telemetry variables are honoured from the shell,
  user settings, `--settings` or managed settings, and ignored in project and local settings
  (/monitoring-usage, Administrator configuration).
- No hook or event reports a skill listed but never invoked (/hooks; /monitoring-usage).
- A mod sees each skill prompt with its source, but not where the built-in guard loads
  (/plugins/mods/reference).

## 11. Not documented, and Loadout depends on it

| Gap | Needed by | Spike |
|---|---|---|
| Whether `/add-dir` mid-session watches the folder's skills, and what it asks | M13 | M13.01 |
| What a running session does when its `--add-dir` folder moves | M12 | M12.01 |
| How the 1% budget becomes characters; listing order; what "invoked least" counts; whether plugin, bundled and synced skills and prompts share the budget | M14 | M14.01 (S14) |
| Whether `--settings` hooks merge, dedupe and wait for trust like file hooks | "MCP servers, hooks and settings in a loadout" | its spike |
| How a `--mcp-config` server ranks against a configured one of the same name; the JSON shape it takes; `${VAR}` in it | same | same |
| Whether a denied `Skill(name)` or `Agent(name)` still sits in the listing | "Agents on and off" | before planning |
| Whether `claudeCode.claudeProcessWrapper` may add flags; `CLAUDE_CODE_PLUGIN_DIRS` in `claudeCode.environmentVariables` or a Desktop environment; flags in the JetBrains command | "A loadout outside the terminal" | its spike |
| Which saved options and data a `--plugin-dir` copy uses when it replaces an installed plugin; whether it keeps hooks and servers | "Part of a plugin in a loadout" | its spike |
| Whether `claude plugin eval` runs on a manifest-less skill folder | "Evidence that a skill triggers" | its spike |
| Which keys a mod's `settings.read` can change (`skillOverrides`, `enabledPlugins`, `hooks`) | "Doctor knows Claude Code" | none planned |
| Any lock or atomic-write contract for `settings.json` | arch §4.5 rule 2 | none possible; keep the re-read |
| The `tool_input` field naming the skill on a `Skill` call; `command_source` values | "Usage" | its spike |
| Whether `--strict-mcp-config` drops claude.ai connectors | "MCP servers, hooks and settings in a loadout" | same spike |
