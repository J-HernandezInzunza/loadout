---
name: flows
description: Run, record or write a Loadout flow, a script that drives the real app over WebDriver on a seeded profile. Use when the user wants a workflow checked end to end in the real app, a demo video of one, or a new flow written from steps they describe.
---

# Flows

A **flow** is `apps/desktop/flows/<name>.flow.ts`: one workflow, driven in the real debug app over WebDriver
on a freshly seeded profile at `/tmp/loadout-demo`. The same file verifies the workflow and, under
`npm run record`, films it. CONTRIBUTING.md ("Profiles, flows and recordings") explains the setup.

## Before any run

- Every Loadout quit (Cmd-Q), the installed one included: one instance runs at a time, whatever its
  profile, and flows refuse to start while one does.
- `apps/desktop/flows/.profiles/github-token.json` exists. If not, run `npm run flows:connect` and have the user
  approve the GitHub code it prints, in their browser.

Done when `pgrep -x loadout` prints nothing and the token file exists.

## Run

Every flow: `npm run flows`. One flow: `npm run app:build:debug` (again only after the app's code
changes), then `npx vitest run --config apps/desktop/flows/vitest.config.ts <name>.flow.ts`.

Done when Vitest reports the flow passed. On a failure, report the step that failed: a `press` or `sees`
timeout names the button or text it waited for. To see what the page showed instead, log
`await b.$("body").getText()` just before that step.

## Record

1. Ask the user to turn on Do Not Disturb and leave the mouse alone: the recorder films whatever is
   drawn over the window's region.
2. `npm run record -- <name>`. It rebuilds the debug app each time (about 40 s), and needs ffmpeg, Swift
   from the Command Line Tools and Screen Recording permission for the terminal app, saying which is
   missing.

Done when it prints `Wrote …/apps/desktop/demo/out/<name>.mp4 (… MB)`; give the user that path.

## Write

1. Map the user's steps onto the seeded machine: `seedDemo` in `packages/sandbox/src/demo.ts` says which
   entry is installed, edited (drifted), behind its source (stale), switched off, pinned, installed by
   hand (unmanaged) and not installed. Pick the entry whose state the steps start from. A screen that
   acts on every copy sees all of those states at once: Sync lists the edited `code-review` beside the
   stale `release-notes`, and asks before overwriting the edit. Where a step reads two ways, pick one and
   say which in your report.
2. Find the wording on screen: buttons and labels in `apps/desktop/src/components/`, state words
   ("edited locally", "update available") in `apps/desktop/src/catalog.ts`. Check the stylesheet too: a
   `text-transform: uppercase` label reads in capitals on the page.
3. Copy the shape of `install.flow.ts`: `freshProfile(flowsToken())`, `profile.open()`, and `close` then
   `dispose` in `afterEach`. Steps use the helpers in `app.ts` and `recording.ts`:
   - `press(b, name)`: a button by its text or `aria-label` (a list row's is `Open <entry>`). It finds
     buttons only, so a heading of the same text never matches.
   - Any other control (a checkbox, a select): find it with `b.$(…)` and `waitForExist`, then
     `pointAt(b, el)`, click, `settle()`, so recordings show the cursor reach it. The app's WebDriver
     server reports every element as not displayed, so `waitForDisplayed` always times out.
   - `sees(b, text)`: waits for text anywhere on the page, the Commands log included. To show something
     is in one list, read that list's element text instead.
   - `chapter(b, title, line)`: a card in recordings, nothing otherwise; one per stage of the workflow.
   - What the app wrote, checked on disk under `app.home`, the profile's home.
4. Undo, before the flow ends, anything it did outside the profile: a pull request it opens on the demo
   repo is closed with its branch deleted (`closeCodeReviewPrs` in `entry.flow.ts`).
5. Run it twice in a row (Run, above).

Done when both runs pass and nothing it opened is left open. Then offer to record it.
