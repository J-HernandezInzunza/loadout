# Roadmap

Directions that aren't planned yet. `PLAN.md` holds planned work as milestones and tasks; an item
here moves there when it is planned, with its decisions. Started 2026-11-04.

## Next: loadouts (M9)

A **loadout** is a named, saved set of catalog entries (skills, prompts, agents) that a user brings
into one Claude Code session on top of their global setup. Their `~/.claude` stays as it is, so
Anthropic's bundled skills, their plugins and their MCP servers still load; the loadout adds a
focused set for the task at hand. Two loadouts can run in two sessions at once.

Decided 2026-11-04 (owner):

- **A layer, not a replacement.** A loadout adds to the session; it doesn't switch off what is
  installed. "Only this loadout" is an optional mode (below), not the main deliverable.
- **Per session.** Applying a loadout is a launch command to paste or alias, not a change to
  `~/.claude`.
- **Local first.** Loadouts are saved on this machine. Sharing comes after.

What the launch can do, from spikes.md S13: `claude --add-dir <loadout folder>` adds the folder's
`.claude/skills`, `commands` and `agents` to that session only. Members keep their own names unless
one clashes with a global item, which then shows as `<loadout>:<name>` while the global copy keeps
the bare name. A `CLAUDE.md` in the folder is read only with
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

Planned as M9 in `PLAN.md`, with its decisions.

## Loadouts, after M9

- **Only this loadout.** A launch that hides everything else: a generated `--settings` file whose
  `skillOverrides` switch off every installed skill and prompt not in the loadout, regenerated on
  every scan so a later install stays hidden. Keeps the user's permissions, hooks and model, which
  `--setting-sources project,local` would drop. Plugin skills ignore `skillOverrides`, and agents
  would need `Agent(name)` deny rules.
- **Share as a plugin.** Export a loadout as a plugin folder or `.zip` for `--plugin-dir`, or a URL
  for `--plugin-url`. Everything in a plugin is prefixed (`<plugin>:<name>`).
- **Does the skill list fit** (was "Context cost", for a loadout and for the global set). Planned as
  M14 in `PLAN.md`, with its decisions.
- **Team loadouts.** Loadouts in a catalog's `library.yaml`, shared and changed through the same PR
  flow as entries. Needs the local format to settle first.
- **A loadout per project.** Remember which loadout a repo uses, so its command is one click.
- **Rename a loadout.** Planned as M12 in `PLAN.md`, with its decisions.
- **A loadout in a running session.** Planned as M13 in `PLAN.md`, with its decisions.
- **A `loadout` skill for agents.** Parked 2026-11-10 (owner): the need behind it is a loadout in the
  session already running (M13); a headless run already works as `loadout run <name> -p "…"`, and an
  agent opening a pane saves little over typing the command. Worth picking up again only for a lead
  session that hands work to sessions with other loadouts. As it stood: an opt-in skill, offered at
  first run and on the Loadouts screen, that teaches an agent the `loadout` command, so "run the
  frontend loadout in a new session" works from inside one. It ships in the app bundle beside
  the script, so skill and CLI come from the same release, and installs through Loadout's own pipeline
  from a built-in read-only catalog (a receipt, the on/off switch, stale after an app update). Two uses:
  headless, `loadout run <name> -p "…"`, which returns to the calling agent (it can't stop to ask for
  permissions, so explicit `--allowedTools` is an open question); and interactive, a new pane or window
  started in the project's folder: herdr when `HERDR_ENV=1`, tmux with `$TMUX`, Terminal.app through
  AppleScript, otherwise the command for the user to paste. `loadout list` grows past names (owner,
  2026-11-09): each loadout's members by type, with their state, so the agent can pick one. A test
  fails when a subcommand isn't in the skill. Spike first: a headless run returning cleanly, and each
  launch starting in the right folder.
- **Always on in a repo.** A loadout that loads in one repo with no launch command: built as a
  plugin in a local marketplace and turned on in that repo's `.claude/settings.local.json`
  (`enabledPlugins`). Everything in it is then prefixed (`<loadout>:<name>`), and `skillOverrides`
  doesn't reach plugin skills. Settings can't add an `--add-dir` folder instead:
  `permissions.additionalDirectories` grants file access only.
- **Install the `loadout` command from the app,** for a `.dmg` install without Homebrew. A link in
  `/usr/local/bin` needs an admin prompt on most Macs (root-owned or missing on Apple Silicon);
  `~/.local/bin` needs none but is on PATH only for users who added it. Never by editing shell
  startup files.
- **Off globally, on in its loadouts.** Planned as M15 in `PLAN.md`, with its decisions.
- **Links instead of copies.** One stored copy of an item, linked into `~/.claude` and into each
  loadout that holds it. Measured in S15: links load, reload and lose a switched-off skill's script as
  copies do; two links to one target list the item once, where an item on globally and in a loadout
  lists twice as copies; a linked skill's file reads need its target allowed, which asks in a loadout
  where a copy asks nothing. Also new: a link command in the host (`Host.fs` has none), a scan that
  knows Loadout's own links (every link reads as unmanaged now), and a store with one folder per
  version and clean-up. Worth it if M14 shows the double listing costs descriptions; it would also let
  an installed skill link into its catalog's clone, so an edit in place becomes a change to offer.
- **Instructions in a loadout.** A `CLAUDE.md` in the folder, launched with the variable above.
- **MCP servers in a loadout.** `--mcp-config` adds servers for the session.

## Catalog quality

- **Skill health checks.** Lint entries before they reach a catalog: frontmatter, description length
  and quality, names that clash across catalogs or with Claude Code's bundled skills. The owner has an
  audit for this in another repository of their engineering library to build on.
- **Usage.** Which skills sessions actually use, from Claude Code's transcripts, to suggest switching
  off what is never used or building a loadout from what is.
- **Cycles in `requires` are allowed** (owner, 2026-11-17). A skill that needs an agent which needs
  the skill back is a pair that installs together, not a fault. Installs already bring both in once
  (`resolveDeps` stops at the re-entry); only the reporting calls it broken. Change: reaching an
  entry that is still being walked skips it silently, with no `cycle` item in `unresolved` and no
  warning; doctor check 24 goes, or drops to info for a cycle that may be accidental. The entry
  screen then shows nothing under Unresolved for a cycle (today it says "This entry will install
  without it", which is false for a cycle). Uninstall already lists the other half as a dependent.
  DEP-05 and check 24 come from `library.py` (check 24 tagged `contract`), so this is a recorded
  divergence: a new row in `open-questions.md` beside A29.

## Proposed 2026-11-14

Suggested from a review of what Claude Code loads today (2.1.325) and of what people who manage a
setup still ask for. The owner kept every entry below as a roadmap item (2026-11-16), including
other agents' folders and Linux and Windows; none is planned yet. The order within each group is
the suggested one. Mechanisms were read from Claude Code's docs, not run, so each needs its spike.

### A loadout is the whole session

- **MCP servers, hooks and settings in a loadout** (extends "Instructions in a loadout" and "MCP
  servers in a loadout" above). The need: a server or a hook for one kind of task, without it
  connecting or running in every session. `--add-dir` loads a folder's skills, prompts and agents
  and nothing else, so `loadout run` composes the rest: `--mcp-config` for servers
  (`--strict-mcp-config` for "only these"), a generated `--settings` file for hooks and permission
  rules, and the variable above for `CLAUDE.md`. A hook is code that runs unasked: the editor shows
  its command, and saving asks. Managed `disableSideloadFlags` rejects `--mcp-config` (Claude Code
  exits), so the run checks for it first. `/add-dir` in a running session (M13) brings none of these.
  Spike: the docs say hooks merge across settings files but don't name `--settings` among them, nor
  where a `--mcp-config` server ranks against a configured one of the same name.
- **Launch defaults.** A loadout remembers the flags it starts with (model, permission mode,
  `--agent`), so a review loadout always starts in plan mode. Anything after the name already goes
  to `claude`; this saves it in the loadout, shown in the card's command.
- **Resuming keeps the loadout.** `claude --resume` and `--continue` don't restore `--add-dir`,
  `--settings` or `--mcp-config` (a folder added with `/add-dir` is forgotten too), so a session
  resumed without `loadout run <name>` comes back without its loadout and says nothing. Claude Code
  has a variable for wrappers, `CLAUDE_CODE_RESUME_HINT_COMMAND` (2.1.323), that makes the hint it
  prints at exit read `loadout --resume <session-id>`. So `loadout run` sets it and starts the
  session with an id it chose (`--session-id`), remembering which loadout that id has, and
  `loadout --resume <id>` brings the same loadout back.
- **A loadout outside the terminal.** The VS Code panel and the desktop app start Claude Code
  themselves and take no launch flags, so no loadout reaches them today. Ways in, to spike: VS
  Code's `claudeCode.claudeProcessWrapper` (Loadout's command as the wrapper, adding the repo's
  loadout, which needs "A loadout per project") or `claudeCode.environmentVariables` with
  `CLAUDE_CODE_PLUGIN_DIRS` (the loadout built as a plugin, so names are prefixed); the JetBrains
  plugin's **Claude command** setting; for the desktop app only environment variables in a saved
  environment are documented. Background sessions carry the flags they were started with; for an
  agent team's teammates only `--settings` and `--setting-sources` are documented to carry.
- **Servers, hooks and rules as catalog entries.** New entry types beside skill, agent and prompt,
  shared through the same PR flow. A server entry holds its definition with `${VAR}` or
  `${VAR:-default}` references, never a secret (Claude Code reads a credential-like variable as
  empty in a remote server's `url` and `headers`, so those use `headersHelper` or the server's own
  sign-in). Options: loadout-only at first (suggested: Loadout writes nothing into
  `~/.claude.json` or the `hooks` key of `settings.json`, files Claude Code also writes), or a
  global install too, with §4.5's careful edit.

### Versions a team can trust

- **Pin, review, roll back.** A receipt already records the source commit and each file's hash.
  Add: a commit pinned per entry in `library.yaml`, so the catalog's PR is the review of an update
  (unpinned stays "the branch's head"); an update preview that calls out new or changed scripts and
  changes to `allowed-tools` and `hooks` in frontmatter; and the replaced version kept, so one entry
  can go back. Published tests of skill scanners found they miss a payload that is hidden on
  purpose. What holds up is a source the team owns, pinned and reviewed, which a catalog already
  is. No scanner of Loadout's own; a catalog's CI can run one.
- **Signing first.** "Developer ID signing and notarization" and the updater (Carried over) are the
  first thing every teammate meets. Suggested ahead of everything else in this section.

### The catalog checks itself

- **`loadout` without the app.** The core already runs on Node (`host-node`); today's `loadout` is
  a script that knows `run` and `list`. A full command (`install`, `sync`, `doctor`, `check`) for
  terminals, CI and containers, every mutation a plan then an apply (arch §8), which also lets an
  agent drive it. The next two entries need it, and it is the cheap way to Linux and Windows. Open:
  how it ships without asking for Node (a single-file build).
- **Checks on a catalog PR.** "Skill health checks" (above) as `loadout check`, run before Loadout
  opens a PR and in the catalog's CI. `claude plugin validate` already lints a folder named
  `skills`, `agents` or `commands` (not one loose skill, and it skips linked ones), with `--json`.
  Loadout adds what only a catalog knows: names that clash across catalogs, a `requires` that
  doesn't resolve, a description past M14's cap.
- **Evidence that a skill triggers.** An entry may carry cases beside its source, in the layout
  Claude Code's own eval tooling reads (`evals/<case>/prompt.md` with graders; a `tool_used` grader
  on `Skill` measures triggering). `claude plugin eval` needs a plugin, so `loadout check --evals`
  wraps the entry as one, runs it, and records `aggregate-result.json`'s outcome with the Claude
  Code version, shown on the entry. Each run uses a temporary home holding only that plugin: it
  shows the skill triggers alone, not among the other skills someone has installed. Real model
  calls (about cases × 3 runs × 2 arms), so never automatic. Spike: the wrapped entry, and a run in
  CI (`--trust-plugin`, `--json`).
- **What changed, and what went stale.** After a sync: the entries added, updated (with the PR that
  changed them) and removed since last time. An optional `owner` on an entry; an entry nobody has
  touched in months is flagged to its owner.

### Plugins

- **See what plugins add.** The scan lists installed plugins (through `claude plugin list --json`,
  not by reading `~/.claude/plugins`), each with its skills, agents, hooks and servers, counted in
  M14's measure. `skillOverrides` doesn't reach a plugin's skills, so the only switch is the whole
  plugin: Loadout offers it per repo (`enabledPlugins` in that repo's `.claude/settings.local.json`).
- **Part of a plugin in a loadout.** A plugin loaded for one session (`--plugin-dir`) replaces an
  installed plugin of the same manifest name, whole and without a message, so a loadout could carry
  a copy holding only the chosen skills. The copy doesn't follow the installed plugin's updates, so
  Sync rebuilds it. Spike: that the copy keeps the prefix, its hooks and its servers.
  `disableSideloadFlags` blocks it.
- **A catalog as a plugin marketplace.** Generate `.claude-plugin/marketplace.json` from
  `library.yaml`, through the same PR flow, so people without Loadout, and organisations that allow
  only plugins (`strictPluginOnlyCustomization`), can install the same entries. A marketplace may
  list plugins that live in other repositories (a `git-subdir` source takes `url`, `path`, `ref`
  and `sha`, so an entry's pin carries over), and a private one uses the machine's git credentials.
  It is also a way into CI without committing anything: Claude Code's GitHub Action takes
  marketplaces and plugins as inputs. Names are then prefixed. For a team it covers "Share as a
  plugin". Spike: an entry as a one-skill plugin, and what `claude plugin validate` says of the
  generated file.

### Teams, repos and cloud sessions

- **A new teammate's first hour.** One command or link that adds the team's catalog, signs in, and
  offers the catalog's starter loadouts by role ("Team loadouts" above comes first). Claude Code has
  no way to target a group of users; roles as loadouts in the catalog fill that. Its
  `/team-onboarding` writes a guide from a teammate's recent sessions and shares the text; it
  doesn't hand over skills, agents or settings, so the two fit together.
- **A loadout committed to a repo.** Write a loadout's members into a repo's `.claude/` with a lock
  file (entry, catalog, commit, file hashes), as a PR to that repo. A cloud session starts from a
  fresh clone and sees only what is committed (nothing from `~/.claude`, no plugin the repo only
  declares; hooks, permission rules and `.mcp.json` only when the session has one repository); so
  do CI and teammates without Loadout. Loadout then shows drift and offers updates as PRs. This
  brings back project scope as an explicit export, not as an install destination. It sits beside
  "A loadout per project" and "Always on in a repo", which stay local to one machine.
  Suggested: committed files for a team, the remembered command for one person.

### Knowing what a session will load

- **Explain a launch.** `loadout run <name> --explain`, and the card's peek: everything the session
  would load and from where (global set, loadout, repo, plugins), what clashes and which copy wins,
  and whether the list fits (M14). On request, checked against Claude Code itself: the first message
  of a `-p --output-format stream-json` run lists what loaded.
- **Doctor knows Claude Code.** A Claude Code too old for something Loadout relies on (before
  2.1.323 a settings edit made close to one of Claude Code's own writes could be lost, and only
  `~/.claude.json` is documented as locked); and a plugin that rewrites settings as they are read,
  so the files Loadout edits may not be what the session uses. Managed settings an organisation
  may have set: `strictPluginOnlyCustomization` stops skills, prompts and agents in `~/.claude` and
  in `--add-dir` folders, which is everything Loadout installs and every loadout (the marketplace
  above is then the only way in); `disableSideloadFlags` rejects `--mcp-config` and `--plugin-dir`
  but not `--add-dir` or `--settings`. Doctor says which is set and what stops working.
- **Usage** (refines the entry under Catalog quality). Claude Code's docs call the transcript
  format internal and liable to change on any release, and `/skill-doctor` already lists unused
  skills inside a session. What Loadout would add is across sessions and repos, per loadout, and
  per catalog entry. Sources, ranked: (1) hooks, the only fully local one: `UserPromptExpansion`
  gives a typed command's name and `PostToolUse` on `Skill` fires for Claude's own calls, each with
  the session and folder. Passed in a loadout's `--settings` file they count that loadout's
  sessions and write nothing into `settings.json`; counting every session means a hook there.
  Spike: the input field that carries the skill's name isn't documented. (2) The
  `claude_code.skill_activated` event, which the docs recommend for finding unused skills: there is
  no file exporter, so it needs a local receiver, and a user's own skills read as `custom_skill`
  unless `OTEL_LOG_TOOL_DETAILS=1`. (3) Transcripts behind a version check. A plugin running
  inside Claude Code can also see each invocation with its source, but not where an organisation's
  guard is loaded.

### Reach

- **Linux, Windows and Intel Macs.** Loadout is for Apple Silicon Macs today, and the README says
  so (owner, 2026-11-16: fine for now). The command first (above), the app after: the keychain, the
  login-shell PATH probe and the cask are Mac-only today.
- **Other agents' folders.** Skills follow an open format that other coding agents read, and
  installing a skill into a second folder is small. Loadouts, on and off, and M14's measure are
  Claude Code's and wouldn't carry, so the first step is installs and Sync only. Claude Code comes
  first for now (owner, 2026-11-16). M8 already reads `~/.agents` as an origin.

### Suggested against

- **Running or watching sessions** (panes, worktrees, boards). `loadout run <name>` is already a
  command those tools can start.
- **A hosted registry.** The catalog is a git repository the team owns; review, history and
  permissions come with it.

## Carried over

- **Developer ID signing and notarization,** which removes the Open Anyway step (arch §7, Q2 A), then
  `tauri-plugin-updater`.
- **Recording workflows in the native app** for README demos (open-questions Q13 c).
- **Agents on and off** ("agents later", Q15 A), through `permissions.deny: ["Agent(<name>)"]` in
  `~/.claude/settings.json`, Claude Code's documented way, keyed by the agent's frontmatter `name`,
  and written with the same careful edit as the skill switch (arch §4.5). It blocks an agent rather
  than hiding it (whether its description still sits in what Claude reads is unchecked), and deny
  lists merge across settings files, so a user-level deny can't be lifted in one project. A deny by
  name may also block a loadout's agent of that name. M15 switches the agents Loadout installed off
  without one; this is left for agents it didn't install.
- **Adopt an unmanaged item into a catalog** (left out of M8: for a link it means replacing it or
  keeping two sources).
- **Small follow-ups from M8:** one shared switch component for EntryList and UnmanagedList; one
  hashing pass shared by `list()` and the scan; the `npx skills` lock under `$XDG_STATE_HOME`.
- **A "Support Loadout" link in the app,** in the About or Help menu, opening the GitHub Sponsors
  page that `.github/FUNDING.yml` and the README already point to.
- **R.08:** a teammate's install and the announcement are still unrecorded.
