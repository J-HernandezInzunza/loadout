# Recording demos

How to get from a fresh clone to a demo video of Loadout, or a seeded app to show live. The videos are the
real app, driven by a script, filmed and framed on a wallpaper: ready for the README, a website or a Slack
thread. CONTRIBUTING.md ("Profiles, flows and recordings") is the reference for each script; this is the
walkthrough.

Three ways to show the app:

| You want | Run | You get |
|---|---|---|
| a video of a workflow | `npm run record -- <flow>` | `apps/desktop/demo/out/<flow>.mp4`, 1600×1000 H.264 |
| to check a workflow still works | `npm run flows` | a pass or a failure naming the step |
| to click through it yourself, or screen-share | `npm run app:profile -- <dir>` | the app, seeded, on a profile of its own |

None of them touch your real `~/.claude`, your accounts or your installed Loadout's data.

## 1. A new machine, once

**The repo and its toolchain** (CONTRIBUTING.md, Setup):

```bash
git clone git@github.com:J-HernandezInzunza/loadout.git && cd loadout
nvm install && nvm use
npm ci
cargo fetch --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run check            # compiles Tauri's dependencies the first time; a few minutes
```

**The GitHub client ID.** Create `apps/desktop/.env.local` with the Loadout OAuth app's client ID
(github.com → Settings → Developer settings → OAuth Apps → Loadout), or copy the file from your old
machine. Without it, sign-in in the app and `flows:connect` refuse to start.

```
LOADOUT_GITHUB_CLIENT_ID=...
```

**Push access to the demo repo.** Every seed resets a branch on
[J-HernandezInzunza/loadout-demo](https://github.com/J-HernandezInzunza/loadout-demo) with your own git
credentials, over HTTPS. If `git push` to a GitHub HTTPS URL asks for a password, run
`gh auth login`, then `gh auth setup-git`.

**The flows' GitHub token.** The flows open the app already connected to GitHub, with a token kept
outside the repo. Get it once:

```bash
npm run flows:connect    # prints a code and opens GitHub; approve it in the browser
```

It's stored in `~/Library/Application Support/loadout-dev/flows-github-token.json` (owner-only) and
doesn't expire. Revoking Loadout in GitHub's settings ends it; run `flows:connect` again then.

**For recording only:**

- **ffmpeg:** `brew install ffmpeg`.
- **Swift:** it comes with the Command Line Tools (`xcode-select --install`). The recorder compiles on
  first use.
- **Screen Recording permission:** the first recording asks for it, for whichever app runs the command
  (Terminal, iTerm, your editor). Grant it in System Settings → Privacy & Security → Screen & System
  Audio Recording, then quit and reopen that app.

**Check it works:**

```bash
npm run flows            # about 40 s; Loadout windows open and close on their own
```

Done when it reports 3 passed.

## 2. Record a video

1. Quit every Loadout, the installed one too (Cmd-Q, not just the window).
2. Turn on Do Not Disturb, and keep your hands off the mouse while it runs: the recorder films the
   window's region of the screen, so a notification or a window dragged over it ends up in the video.
3. Run one flow:

   ```bash
   npm run record -- install
   ```

   It rebuilds the debug app (about 40 s), opens it on a fresh profile, moves the window to your
   sharpest display and brings it to the front, plays the flow at a watchable pace, then composites.

4. It ends with `Wrote …/apps/desktop/demo/out/install.mp4 (0.5 MB)`. `apps/desktop/demo/` is
   git-ignored, so keep the videos you like somewhere else.

**The flows there are:**

| Flow | Shows | Length |
|---|---|---|
| `install` | opening a skill in the catalog, previewing what goes where, installing it | ~13 s |
| `entry` | an edited copy's page: Send edits back opens a real pull request on the demo repo (closed again at the end), then Remove | ~23 s |
| `sync` | checking for updates, finding a copy behind its source, syncing it | ~15 s |

**Another display:** the recorder picks the sharpest display (a Retina one over an external monitor).
To choose, list them and pass an ID:

```bash
apps/desktop/demo/.bin/recorder displays     # after the first recording has built it
RECORD_DISPLAY=<id> npm run record -- install
```

**What the video looks like:** the window keeps its real title bar and buttons, framed on a gradient
wallpaper with a shadow; a cursor glides to each button before it's clicked, and a title card marks each
stage (`chapter()` in the flow). The cursor and cards are drawn in the page, and only while recording.

## 3. Show it live

To click through it yourself, on a call or in front of colleagues:

```bash
npm run app:profile -- ~/loadout-demo
```

It builds the debug app, then the first run makes and seeds `~/loadout-demo` (about a minute); later
runs reopen it as you left it.
The seeded machine has a team catalog and a copy in every state the app shows: installed, edited
locally, behind its source, switched off, pinned, installed by hand, and not installed. To show anything
that talks to GitHub, connect it in the app first (sidebar → GitHub → Connect). Delete the folder to
start over.

## 4. A new flow

The easiest way is to ask an agent in this repo: the `flows` skill (`.claude/skills/flows/SKILL.md`)
knows the seeded states, the helpers and the cleanup rules. Describe the steps as a user would do them,
for example "open Sync, check for updates, sync release-notes", and ask for a flow. It writes
`apps/desktop/flows/<name>.flow.ts`, runs it twice, and offers to record it.

By hand: copy `install.flow.ts`. A flow is a Vitest test; `freshApp()` opens the app and cleans up after
it, `press(b, "Button text")` clicks, `sees(b, "text")` waits for something on screen, and
`chapter(b, title, line)` adds a title card. Anything it does outside the profile (a pull request, a
branch) it must undo, as `entry.flow.ts` does.

## 5. Using the videos

- **README or a GitHub comment:** drag the `.mp4` into the editor on github.com. GitHub uploads it and
  puts a link in the text that renders as a player. These videos are around 1 MB, well under GitHub's
  limit.
- **A website:** the files are H.264 with fast start, so a plain
  `<video src="install.mp4" autoplay muted loop playsinline>` plays them in any browser.
- **Slack and the rest:** they're ordinary MP4s.

A video shows whatever the app looks like when you record it. After a UI change, record again.

## Troubleshooting

| Message | What to do |
|---|---|
| `Loadout is already running (pid …)` | Quit it with Cmd-Q; `pgrep -x loadout` should print nothing. A flow that crashed can leave one: `kill <pid>`. |
| `flows have no GitHub token yet` | `npm run flows:connect` |
| `no LOADOUT_GITHUB_CLIENT_ID in …/.env.local`, or the app's "no GitHub client ID" banner | Add it (section 1). The app picks it up on its next build. |
| a seed fails at `git push` or `git fetch` | Your git can't reach or push to the demo repo over HTTPS (section 1), or there's no network. |
| `no clickable button "…"` or `"…" never showed` | The wording on screen changed, or the app showed something else at that step. Run the flow alone (the skill says how) and compare with the app. |
| `the recorder didn't compile …` | The Command Line Tools are broken: `sudo rm -rf /Library/Developer/CommandLineTools`, then `xcode-select --install`. |
| `process … has no window on screen` | The window opened in another Space or behind a full-screen app. Leave full screen and record again. |
| `no frames were captured` | The window was covered or never drew. Record again, hands off. |
| a notification or another window in the video | Do Not Disturb, and nothing over the app's window while it records. |
| `swiftc is needed` or `ffmpeg is needed` | Section 1, "For recording only". |
