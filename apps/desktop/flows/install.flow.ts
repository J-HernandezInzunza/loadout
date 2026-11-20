// Install a skill from the catalog, through its preview.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshApp, press, sees } from "./app.ts";
import { chapter } from "./recording.ts";

describe("install a skill", () => {
  it("previews what goes where, then installs test-first", async () => {
    const app = await freshApp();
    const b = app.browser;
    const dest = join(app.home, ".claude/skills/test-first/SKILL.md");

    await chapter(b, "Install a skill", "See what goes where before anything is written");
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
