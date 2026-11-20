// Sync: the check finds release-notes behind its source, and syncing brings the installed copy up to it. Sync
// takes every copy it lists, so the edited code-review goes too, once its overwrite is acknowledged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshProfile, press, sees, type RunningApp } from "./app.ts";
import { chapter, pointAt, settle } from "./recording.ts";
import { flowsToken } from "./token.ts";

const newLine = "Put breaking changes first, under their own heading.";

let token: string;
let app: RunningApp | undefined;
let profile: Awaited<ReturnType<typeof freshProfile>> | undefined;
beforeAll(() => {
  token = flowsToken();
});
afterEach(async () => {
  await app?.close();
  profile?.dispose();
});

describe("sync installed entries", () => {
  it("finds release-notes behind its source, then syncs it", async () => {
    profile = await freshProfile(token);
    app = await profile.open();
    const b = app.browser;
    const copy = join(app.home, ".claude/skills/release-notes/SKILL.md");

    await chapter(b, "Check for updates", "Every installed copy, against its source");
    await press(b, "Sync");
    await sees(b, "2 to update");
    const waiting = await b.$('//li[contains(@class, "sync__item")][.//span[normalize-space(.)="release-notes"]]');
    await waiting.waitForExist({ timeout: 15_000, timeoutMsg: "release-notes isn't listed to update" });
    expect(readFileSync(copy, "utf8")).not.toContain(newLine);

    await chapter(b, "Sync", "The installed copy catches up with its source");
    // A checkbox, which press can't reach: code-review's local edits are what Sync would discard.
    const overwrite = await b.$('//label[contains(., "Overwrite 1 locally edited copy")]//input');
    await pointAt(b, overwrite);
    await overwrite.click();
    await settle();
    await press(b, "Sync 2");
    await sees(b, "2 updated");
    expect(readFileSync(copy, "utf8")).toContain(newLine);
  });
});
