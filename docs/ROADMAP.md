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
- **Off globally, on in its loadouts: the global set as a baseline** (owner, 2026-11-10; direction
  chosen 2026-11-13). Switch a niche skill off in `~/.claude` to keep it out of every session, and
  still have it load in the loadouts that hold it. Today it doesn't: the override is by name, so it
  hides the loadout's copy too, prefixed or not (S13, the `hidden` clash). Works now without a
  change: uninstall the global copy, since a loadout builds its own copy from the catalog.
  Direction: `~/.claude` becomes a view of what is switched on, built as a loadout's folder is
  (M9.03), so off means absent from `~/.claude` and a loadout's copy loads under its bare name, at
  launch and mid-session. It replaces §4.5's override for what Loadout installs. To confirm when it
  is planned:
  1. On/off is saved per entry in `config.json`; the disk is the result, so off and deleted by hand
     differ.
  2. Copies, not symlinks. Measured 2026-11-13 through `--add-dir` (2.1.323): linked skill folders,
     command and agent files load and reload live, but `${CLAUDE_SKILL_DIR}` is the link's path, so a
     session still loses a switched-off skill's scripts; `rm -rf` on a linked folder with a trailing
     slash deletes the shared copy; an editor's save by rename turns a linked `.md` into a real file;
     a dotfiles repo of `~/.claude` stores `~/Library` paths; and the scan (every link reads as
     unmanaged), `Host.fs` (no link creation) and a versioned store with clean-up would all be new.
     Links' one gain, one copy for an item on globally and in a loadout, isn't this case.
  3. Off moves Loadout's copy into a cache in app data; on reuses it when it still matches what the
     entry would build now, else installs fresh with the preview. Edits survive and on works
     offline. A cache, so Sync never keeps it current (unlike the archive INST-06 refreshed).
  4. A skill another switched-on item requires stays in while it's needed ("on for <item>"), and
     switching an item on brings what it requires.
  5. Only what Loadout installed; other items keep the override switch, which the UI says also
     hides a loadout's copy. Adopting an unmanaged item (below) brings it in.
  6. Overrides Loadout wrote convert once, after the user has seen the list (as §4.5 rule 7).
  Agents switch on and off the same way, with no deny rule. Costs: a running session loses a
  switched-off item's files, Claude Code's `/skills` can't switch it back on, and the UI has two kinds
  of off; about M9's size. Spike first, in `~/.claude` itself (it needs the owner's go-ahead to write
  there): a skill, a prompt and an agent moved out during a session (each leaves it? a session
  running the skill's scripts?); a loadout's copy loading under its bare name once the global copy is
  gone, at launch and with `/add-dir`; and the link results above, repeated in `~/.claude`. Set
  aside for this need: a `--settings` file per loadout (the global copy comes back, listed twice), a
  renamed folder (leans on S10's undocumented match) and loadouts built as plugins. Ties to M14,
  where off becomes the strongest fix.
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
  name may also block a loadout's agent of that name; the baseline (above) would switch agents off
  without one.
- **Adopt an unmanaged item into a catalog** (left out of M8: for a link it means replacing it or
  keeping two sources).
- **Small follow-ups from M8:** one shared switch component for EntryList and UnmanagedList; one
  hashing pass shared by `list()` and the scan; the `npx skills` lock under `$XDG_STATE_HOME`.
- **A "Support Loadout" link in the app,** in the About or Help menu, opening the GitHub Sponsors
  page that `.github/FUNDING.yml` and the README already point to.
- **R.08:** a teammate's install and the announcement are still unrecorded.
