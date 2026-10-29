import { describe, expect, it } from "vitest";
import { activityLabel, describeArgv } from "./activity.ts";

describe("UI-49: the activity label", () => {
  it("names git's subcommand, past its global options, rather than the whole argv", () => {
    expect(describeArgv(["git", "-C", "/Users/dev/app/clones/team", "pull", "--quiet", "--ff-only"])).toBe("git pull");
    expect(describeArgv(["git", "-c", "credential.helper=", "-c", "credential.helper=!f() { … }; f", "clone", "--depth", "1", "https://x/o/r.git", "/tmp/r"])).toBe("git clone");
    expect(describeArgv(["/usr/bin/git", "--version"])).toBe("git");
  });

  it("caps any phrase long enough to need clipping", () => {
    const label = describeArgv(["git", "x".repeat(400)]);
    expect(label.length).toBeLessThanOrEqual(61);
    expect(label.endsWith("…")).toBe(true);
  });

  it("prefers the running command, else the newest intent, else nothing", () => {
    expect(activityLabel(["git", "-C", "/c", "pull"], ["refreshing the catalog…"])).toBe("git pull");
    expect(activityLabel(undefined, ["reading the catalog…", "installing tidy…"])).toBe("installing tidy…");
    expect(activityLabel(undefined, [])).toBe("");
  });
});
