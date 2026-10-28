# M0 spikes

The ten checks listed in `open-questions.md` Part 5 (including the `skillOverrides` checks from
architecture.md §4.5), run 2026-10-28 on the owner's Mac (macOS 15, Apple Silicon), Claude Code
2.1.312, Tauri 2.12, git 2.56 (Homebrew) and 2.39.5 (Apple), gh 2.101.0. Each entry gives the
question, how it was tested, the result, and what changed in the spec because of it.

**Summary**

| # | Question | Result | Spec change |
|---|---|---|---|
| S1 | Does a Finder-launched app get the ssh agent and git credential helpers? | Yes, both | none |
| S2 | How does the shell plugin resolve `git`/`gh` with a widened PATH? | Through the process PATH, so order matters; appending picked Apple's git | arch §5.3: shell PATH **first**; probe timeout 10 s |
| S3 | fs-plugin speed on the largest real skill folder | ~6 ms per file; largest real skill ≈ 0.2 s | arch §10 risk 8: no Rust fallback needed now |
| S3a | (found while running S3) fs scope and dot-directories | `$HOME/**` excluded `~/.claude`; `$APPDATA/**` excluded `$APPDATA` | arch §2.4: `requireLiteralLeadingDot: false`, allow `$APPDATA` |
| S4 | Direct push from a shallow clone to a real remote | Works; stale push rejected cleanly; `pull --ff-only` works shallow | none |
| S5 | `gh pr create` output | stdout is the URL only; a duplicate exits 1 with the existing URL on stderr | WRITE-11 recommendation (below) |
| S6 | May a personal-tap cask run `xattr` after install? | Only through legacy Ruby `postflight`, which Homebrew is phasing out | none (Q2 B already chose `caveats`) |
| S7 | Does a project's `skillOverrides` replace or merge with the user's? | Merges per key; a local `"on"` beats a user `"off"` | arch §4.5 rule 4, risk 11 |
| S8 | Does a toggle reach an already-open session? | Yes: the next invocation is refused | arch §4.5 |
| S9 | Do `~/.claude/commands/*.md` prompts obey `skillOverrides`? | Yes | arch §4.5 (removes "to verify") |
| S10 | Is a skill matched by its frontmatter `name`? | **No: by its folder name** | arch §4.5 rule 1 rewritten |

## How the app spikes were run (S1–S3)

`apps/desktop/src/spike/run.ts` is a probe harness compiled only when `VITE_SPIKE=1`. It runs in the
webview through the real plugins and capability file, writes
`~/Library/Application Support/com.jhernandezinzunza.loadout/spike-results.json`, and appends
progress to `~/Library/Logs/loadout-spike.log` through `git` (a side channel that works even when
plugin-fs is the thing failing). To re-run it, for example on a teammate's Mac:

```bash
cd apps/desktop && VITE_SPIKE=1 npx tauri build --debug --bundles app
osascript -e "tell application \"Finder\" to open POSIX file \"$PWD/src-tauri/target/debug/bundle/macos/Loadout.app\""
```

**Launch through Finder, not `open`.** `open` from a terminal hands the app the terminal's
environment (verified with `ps eww <pid>`, which shows a process's environment as it was at exec):
the first runs looked fine only because of that. Through Finder the exec-time PATH was
`/usr/bin:/bin:/usr/sbin:/sbin`, as architecture.md §5.3 expects. `launchctl getenv PATH` is empty;
launchd's user environment carries only `SSH_AUTH_SOCK` and `DISPLAY`; `SHELL`, `HOME` and `USER`
are set.

## S1. ssh agent and credential helpers under a Finder launch

- `SSH_AUTH_SOCK` is set (launchd provides it to every GUI app).
- `git ls-remote git@github.com:J-HernandezInzunza/loadout.git HEAD` with
  `GIT_SSH_COMMAND="ssh -oBatchMode=yes"`, `GIT_TERMINAL_PROMPT=0`: exit 0 in ~1 s.
- `git ls-remote https://github.com/<owner>/<private repo>.git HEAD` with prompts disabled and
  `GIT_ASKPASS=/usr/bin/true` (exactly as FETCH-03 runs git): exit 0 in ~1.2 s, so the
  `osxkeychain` helper supplied credentials.
- `gh auth status`: exit 0.

**Result:** the CLI's non-interactive git environment (FETCH-02/03) works unchanged from the app.
Not covered: Bitbucket (same mechanisms; verify against the team catalog in M2), and a machine
whose ssh key needs a passphrase not held by the agent (BatchMode makes that fail fast, then https
is tried, which is the designed fallback).

A first attempt used `git credential fill` from the webview and timed out after 20 s, while the
same command returns at once in a terminal. That was an artifact of the probe (stdin handling
through the shell plugin's `Child.write`), not of git, and the https `ls-remote` above replaced it.
Worth knowing for M2: the core must never need to write to a child's stdin.

## S2. Resolving `git` and `gh`

The shell plugin spawns `Command::new("git")`, so the program is found through the process PATH at
spawn time, after `path::repair_env()` has run.

| PATH policy | `git` resolved to | `gh` resolved to |
|---|---|---|
| Old app's (append the login shell's PATH), probe within 3 s | — (probe timed out, see below) | — |
| Append, probe succeeded | `/Library/Developer/CommandLineTools/…/git`, **Apple git 2.39.5** | `/opt/homebrew/bin/gh` |
| **Login shell's PATH first** (new) | Homebrew git 2.56.0 | `/opt/homebrew/bin/gh` |

Appending keeps launchd's `/usr/bin` ahead of Homebrew. On this machine that silently picked an
older git; on a Mac with Homebrew git but no Command Line Tools, `/usr/bin/git` is the stub that
opens the "install developer tools" dialog, so appending would trigger that dialog although a
working git is installed. The new rule: the login shell's PATH in its own order, then whatever the
process had, then fallbacks (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`). A terminal or
`tauri dev` launch already has the shell's PATH, so it is unchanged.

**The probe timeout.** `zsh -ilc` on this machine takes 2.0–3.1 s (nvm, jenv, cloud SDK setup);
the first, coldest run exceeded the old 3 s limit and the app fell back to the fallbacks only. The
timeout is now 10 s. That bounds a pathological profile, but an ordinary heavy profile still
delays the first window by 2–3 s on every launch. Options for M4, ranked: (1) cache the probed
PATH in app data and use it at once, refreshing it in the background for the next launch; (2) run
the probe on a thread and pass `PATH` explicitly in each spawn's `env` (needs the host to learn the
PATH, i.e. a command or an event, which arch §2.4 wants to avoid); (3) accept the delay.

`CLAUDE_CONFIG_DIR` capture could not be exercised here (the variable is unset in this shell); it
is covered by unit tests in `apps/desktop/src-tauri/src/path.rs`.

Side finding: the shell scope `{cmd: "git", args: true}` is not a sandbox. `git -c
alias.x='!<shell>' x` runs arbitrary shell commands (the harness relies on it for its log). That is
consistent with arch §2.4 (the webview runs only bundled code; args are never user text), but the
capability file should not be described as limiting what the app can execute.

## S3. fs-plugin speed

Walk (`readDir`), read (`readFile`), hash (`crypto.subtle` SHA-256) and copy (`mkdir` + `writeFile`)
of the largest folder in `~/.claude/skills`, all through plugin-fs IPC, from a Finder launch:

| Folder | Files | Bytes | walk | read | sha256 | copy |
|---|---|---|---|---|---|---|
| `synced` (cold) | 231 | 4.1 MB | 503 ms | 1048 ms | 42 ms | 1532 ms |
| `synced` (warm) | 231 | 4.1 MB | 153 ms | 570 ms | 15 ms | 931 ms |
| `cp -R` of the same folder, for comparison | | | | | | 160 ms |

`synced` is the claude.ai-synced folder, which SCAN-01 skips, so it is an upper bound. The largest
real installable skill on this machine has 21 files (`agent-retro`), so roughly 0.15–0.25 s for
read + hash + copy. **Result:** plugin-fs is about 10× slower than a native copy (per-file IPC,
~6 ms per file read + write), which is acceptable for installs. Revisit (arch §10 risk 8: a Rust
`copy_tree` command) only if `sync` across many skills measures slow in M2.

## S3a. fs scope and dot-directories (found while running S3)

1. `$HOME/**` refused `~/.claude/skills`: "forbidden path … not allowed on the scope for
   `allow-read-dir`". Tauri's fs plugin defaults to `requireLiteralLeadingDot: true` on Unix, so
   `*` and `**` never match a path component that starts with `.`. That excludes `~/.claude`
   entirely, and also any dotfile inside a skill (`.env`, `.gitignore`). Fixed with
   `plugins.fs.requireLiteralLeadingDot: false` in `tauri.conf.json` (chosen over adding
   `$HOME/.claude/**`, which would still miss dotfiles inside skills). The denies are literal paths,
   so they still apply.
2. `$APPDATA/**` does not match `$APPDATA` itself, so the app could not create its own data folder
   on first launch. Fixed by also allowing `$APPDATA`.
3. Adding `plugins.fs` to `tauri.conf.json` makes `generate_context!` use `serde_json`, which the
   crate must therefore depend on.

Both scope rules are pinned by `test/capabilities.test.ts`.

**Recommendation (not applied):** with dot-directories now inside the scope, the deny list (R3:
`.ssh`, `Keychains`, `.gnupg`) leaves other credential stores readable by the webview:
`~/.config/gh/hosts.yml` (gh's token), `~/.aws`, `~/.netrc`, `~/.docker/config.json`,
`~/.kube`. The webview loads only bundled code with a strict CSP, so this is defence in depth, but
it is cheap: add those to `deny`. Decide in PLAN.md's open questions.

## S4. Direct push from a shallow clone

On a scratch branch `spike/catalog` of this repo (deleted afterwards):

1. `git clone --depth 1 --single-branch --branch spike/catalog git@github.com:…` (the persistent
   catalog clone's shape, RCAT-03), commit, `git push origin HEAD:spike/catalog` (WRITE-13):
   accepted, `49c5d7e..cbad567`, remote tip equals local.
2. A second clone pushed first; the first clone's push was then rejected with
   `! [rejected] HEAD -> spike/catalog (fetch first)`. WRITE-09's classifier looks for `remote
   rejected`, `denied`, `permission`, `403` and similar, none of which match, so this reports as
   an ordinary `push failed`, not "you lack write access". Correct.
3. `git pull --ff-only` in the shallow clone after upstream moved: fast-forwarded, still shallow.

**Result:** direct mode works on shallow persistent clones; no spec change.

## S5. `gh pr create` output

WRITE-07's flow (single-branch clone, `checkout -b`, commit, `push -u origin <branch>`) then
WRITE-11's argv plus `--draft`, base `spike/catalog` (PR #2, closed and its branch deleted at once):

| Case | Exit | stdout | stderr |
|---|---|---|---|
| Created | 0 | `https://github.com/J-HernandezInzunza/loadout/pull/2` | empty |
| Same head again | 1 | empty | `a pull request for branch "<head>" into branch "<base>" already exists:` + newline + the existing PR's URL |

**Result:** "PR URL = stdout stripped" holds when gh is not attached to a terminal.
**Recommendation (not applied):** WRITE-11 reports gh's *last stderr line* on failure, which for
a duplicate is a bare URL with no explanation. Treat "already exists" as success and return the
existing URL; it makes a retried write idempotent. Decide in PLAN.md's open questions.

## S6. Quarantine removal from a personal-tap cask

From Homebrew's docs (Cask Cookbook, "Stanza: `*flight_steps`"; Security and Supply Chain; FAQ):
official casks must use structured `*flight_steps`, which allow only a fixed set of step calls;
legacy Ruby `postflight` blocks "remain available temporarily for third-party tap compatibility".
Homebrew's stated policy is to refuse to normalise Gatekeeper bypasses. **Result:** a personal-tap
`postflight` running `xattr` would work today but is on a deprecation path. Q2 B (`caveats`)
stands; Developer ID signing remains the durable fix (arch §7). Not executed: no tap was created.

## S7–S10. `skillOverrides`

Run headless: `claude -p --model haiku --output-format stream-json --verbose` in a throwaway project
with test skills under `.claude/skills/` and a prompt under `.claude/commands/`. The `system/init`
event lists the session's `skills` and `slash_commands`; it reflects overrides (the owner's real
user-level `"audit-skill": "off"` is absent from both lists), which made it a deterministic probe.
The owner's `~/.claude/settings.json` was never modified (SHA-256 checked before and after).

### S7. User vs project-local: merge per key

| Settings | Result |
|---|---|
| user: `audit-skill: off` (real); local: `loadout-spike-c: off`, `loadout-spike-cmd: off` | all three hidden: the local object did not replace the user's |
| user: `audit-skill: off`; local: `audit-skill: on` | `audit-skill` visible again in that project |

**Result:** `skillOverrides` merges per key across settings files, with the usual precedence (local
> project > user) applied per key. So a global "off" written by Loadout keeps applying in every
project, except where that project sets the same skill to another value (which the `/skills` menu
does, into `.claude/settings.local.json`).

### S8. Live reload

One long-lived session (`--input-format stream-json`): invoke `loadout-spike-a` via the Skill tool
(succeeds), write `"loadout-spike-a": "off"` to the settings file, wait 5 s, invoke again. The
second invocation fails with `Skill loadout-spike-a is disabled for model invocation in
skillOverrides settings`, and the session re-emits its init event without the skill.
**Result:** a toggle takes effect in open sessions without a restart. Caveat: the model may still
*mention* the skill if it was listed earlier in that conversation; it just cannot run it.

### S9. Prompts in `~/.claude/commands`

The owner's `~/.claude/commands/audit-skill.md` is the only command whose name has
`"off"`, and it is the only one missing from the session (its sibling commands `fleet`, `grill-me`,
`review-branch`, `triage-bug` are present; the files have the same frontmatter shape). Project
commands behave the same (`loadout-spike-cmd` hidden by a local override). **Result:** prompts obey
`skillOverrides`; Q15 A (toggle skills and prompts) needs no special case.

### S10. Which name is the key

A skill in folder `spike-b-folder` with frontmatter `name: loadout-spike-b-declared`:

| Override | Effect |
|---|---|
| `"loadout-spike-b-declared": "off"` | none: still listed and invocable |
| `"spike-b-folder": "off"` | hidden |

The init event also lists the skill as `spike-b-folder`. **Result:** in Claude Code 2.1.312 the key
is the **folder name**, contradicting both arch §4.5 rule 1 and the docs' "a skill's name is its
frontmatter `name` when set". Tested on project-scope skills; no user-scope skill on this machine
has a differing frontmatter name, and creating one was outside what the owner approved. Because
Loadout installs a skill into `~/.claude/skills/<entry name>/`, the folder name is always the
catalog entry name, so the rule is simple: **toggle by entry name**. Re-check on Claude Code
upgrades (doctor can compare the init list's spelling if it ever changes).
