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
