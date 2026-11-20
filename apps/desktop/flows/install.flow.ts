// Install a skill from the catalog, through its preview.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshProfile, press, sees, type RunningApp } from "./app.ts";
import { flowsToken } from "./token.ts";

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

describe("install a skill", () => {
  it("previews what goes where, then installs test-first", async () => {
    profile = await freshProfile(token);
    app = await profile.open();
    const b = app.browser;
    const dest = join(app.home, ".claude/skills/test-first/SKILL.md");

    await press(b, "Open test-first");
    await press(b, "Install and set up");
    await press(b, "Preview install");
    await sees(b, "nothing has been written");
    expect(existsSync(dest)).toBe(false);

    await press(b, "Install");
    await sees(b, "Installed 1 item");
    expect(existsSync(dest)).toBe(true);
  });
});
