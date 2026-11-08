import { loadoutRecord } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import { clashText, loadoutSummary, needsSync, savedOutcome } from "./loadouts.ts";

const member = (name: string, state: "built" | "stale" | "missing" | "failed") => ({ type: "skill" as const, name, resolvesTo: "team", state });

describe("loadout wording", () => {
  it("sums a loadout up by its members' states, and offers Sync only for what Sync can fix", () => {
    const fine = loadoutRecord({ members: [member("a", "built"), member("b", "built")] });
    const behind = loadoutRecord({ members: [member("a", "stale"), member("b", "missing"), member("c", "failed"), member("d", "built")] });
    const unknown = loadoutRecord({ members: [member("c", "failed")] });

    expect(loadoutSummary(fine)).toBe("2 members · all built");
    expect(loadoutSummary(behind)).toBe("4 members · 1 out of date · 1 not built · 1 in no catalog");
    expect(loadoutSummary(loadoutRecord({ members: [] }))).toBe("0 members");
    expect([needsSync(fine), needsSync(behind), needsSync(unknown)]).toEqual([false, true, false]);
  });

  it("says what a session makes of each kind of clash", () => {
    const clash = { type: "skill" as const, name: "grilling", with: "skill" as const };
    expect(clashText({ ...clash, outcome: "prefixed", sessionName: "kit:grilling" })).toBe(
      "Your global skill keeps /grilling; in a session this one is /kit:grilling.",
    );
    expect(clashText({ ...clash, outcome: "hidden", sessionName: null })).toBe("Won't load: your global skill grilling is turned off, and that hides this one too.");
    expect(clashText({ ...clash, with: "prompt", outcome: "shadows", sessionName: "grilling" })).toBe(
      "Takes /grilling in a session, so your global prompt of that name won't load there.",
    );
    expect(clashText({ ...clash, type: "prompt", with: "prompt", outcome: "prefixed", sessionName: "kit:grilling" })).toBe(
      "Your global prompt keeps /grilling; in a session this one is /kit:grilling.",
    );
    expect(clashText({ ...clash, type: "agent", with: "agent", outcome: "unknown", sessionName: null })).toBe(
      "An agent named grilling is installed globally; which one Claude Code uses hasn't been checked.",
    );
  });

  it("reports a save by what was built, and what didn't build with why", () => {
    const ref = (name: string, requiredBy: string[] = []) => ({ type: "skill" as const, name, dest: `/l/${name}`, requiredBy });
    const record = loadoutRecord({ name: "review" });

    expect(savedOutcome({ ...record, build: { built: [ref("a"), ref("b", ["a"])], failed: [], removed: [{ type: "skill", name: "c", dest: "/l/c" }] } })).toEqual({
      kind: "success",
      message: "Saved review: 2 entries built, 1 removed.",
    });
    expect(
      savedOutcome({
        ...record,
        build: {
          built: [ref("a")],
          failed: [
            { type: "skill", name: "x", requiredBy: [], reason: "clone failed" },
            { type: "skill", name: "y", requiredBy: ["a"], reason: "no catalog defines it" },
          ],
          removed: [],
        },
      }),
    ).toEqual({
      kind: "warning",
      message: "Saved review, but 2 entries didn't build. The rest are ready; Sync tries the others again.",
      detail: "x: clone failed\ny (required by a): no catalog defines it",
    });
  });
});
