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
- **Context cost.** How much of the skill list Claude reads each session a loadout adds: its
  members' names and descriptions, as a count and a share of the global set, shown while editing it.
- **Team loadouts.** Loadouts in a catalog's `library.yaml`, shared and changed through the same PR
  flow as entries. Needs the local format to settle first.
- **A loadout per project.** Remember which loadout a repo uses, so its command is one click.
- **Always on in a repo.** A loadout that loads in one repo with no launch command: built as a
  plugin in a local marketplace and turned on in that repo's `.claude/settings.local.json`
  (`enabledPlugins`). Everything in it is then prefixed (`<loadout>:<name>`), and `skillOverrides`
  doesn't reach plugin skills. Settings can't add an `--add-dir` folder instead:
  `permissions.additionalDirectories` grants file access only.
- **Install the `loadout` command from the app,** for a `.dmg` install without Homebrew. A link in
  `/usr/local/bin` needs an admin prompt on most Macs (root-owned or missing on Apple Silicon);
  `~/.local/bin` needs none but is on PATH only for users who added it. Never by editing shell
  startup files.
- **Instructions in a loadout.** A `CLAUDE.md` in the folder, launched with the variable above.
- **MCP servers in a loadout.** `--mcp-config` adds servers for the session.

## Catalog quality

- **Skill health checks.** Lint entries before they reach a catalog: frontmatter, description length
  and quality, names that clash across catalogs or with Claude Code's bundled skills. The owner has an
  audit for this in another repository of their engineering library to build on.
- **Context cost of the global set.** The same measure as a loadout's, for everything installed.
- **Usage.** Which skills sessions actually use, from Claude Code's transcripts, to suggest switching
  off what is never used or building a loadout from what is.

## Carried over

- **Developer ID signing and notarization,** which removes the Open Anyway step (arch §7, Q2 A), then
  `tauri-plugin-updater`.
- **Recording workflows in the native app** for README demos (open-questions Q13 c).
- **Agents on and off** ("agents later", Q15 A), likely through `Agent(name)` deny rules.
- **Adopt an unmanaged item into a catalog** (left out of M8: for a link it means replacing it or
  keeping two sources).
- **Small follow-ups from M8:** one shared switch component for EntryList and UnmanagedList; one
  hashing pass shared by `list()` and the scan; the `npx skills` lock under `$XDG_STATE_HOME`.
- **A "Support Loadout" link in the app,** in the About or Help menu, opening the GitHub Sponsors
  page that `.github/FUNDING.yml` and the README already point to.
- **R.08:** a teammate's install and the announcement are still unrecorded.
