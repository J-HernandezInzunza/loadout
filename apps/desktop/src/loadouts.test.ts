import { loadoutRecord } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import { checkedOutcome, clashShort, clashText, loadoutSummary, needsSync, savedOutcome, syncedOutcome } from "./loadouts.ts";

const member = (name: string, state: "built" | "stale" | "missing" | "failed", type: "skill" | "agent" | "prompt" = "skill") => ({ type, name, resolvesTo: "team", state });
const summary = (loadout: Parameters<typeof loadoutSummary>[0]) => loadoutSummary(loadout).map((part) => part.text).join(" · ");

describe("loadout wording", () => {
  it("sums a loadout up by its members' types and states, and offers Sync only for what Sync can fix", () => {
    const fine = loadoutRecord({ members: [member("a", "built"), member("b", "built")] });
    const behind = loadoutRecord({ members: [member("a", "stale"), member("b", "missing"), member("c", "failed"), member("d", "built")] });
    const unknown = loadoutRecord({ members: [member("c", "failed")] });
    const mixed = loadoutRecord({ members: [member("p", "built", "prompt"), member("a", "built"), member("r", "built", "agent"), member("b", "built")] });

    expect(loadoutSummary(fine)).toEqual([
      { type: "skill", text: "2 skills" },
      { type: null, text: "all built" },
    ]);
    expect(summary(behind)).toBe("4 skills · 1 out of date · 1 not built · 1 in no catalog");
    expect(summary(mixed)).toBe("2 skills · 1 agent · 1 prompt · all built");
    expect(loadoutSummary(loadoutRecord({ members: [] }))).toEqual([{ type: null, text: "No members" }]);
    expect([needsSync(fine), needsSync(behind), needsSync(unknown)]).toEqual([false, true, false]);
  });

  it("says what a check for updates found: nothing, members that need Sync, or members it couldn't check", () => {
    const fine = loadoutRecord({ name: "review", members: [member("a", "built")] });
    const docs = loadoutRecord({ name: "docs", members: [member("a", "stale"), member("b", "missing"), member("c", "failed")] });
    const kit = loadoutRecord({ name: "kit", members: [member("d", "stale")] });
    const offline = loadoutRecord({ name: "solo", members: [{ ...member("e", "built"), unchecked: true }, member("f", "built")] });

    expect(checkedOutcome([fine])).toEqual({ kind: "success", message: "Every loadout is up to date." });
    expect(checkedOutcome([fine, docs])).toEqual({ kind: "warning", message: "2 members of docs need Sync.", detail: "docs: a (out of date), b (not built)" });
    expect(checkedOutcome([docs, kit])).toEqual({
      kind: "warning",
      message: "3 members in 2 loadouts need Sync.",
      detail: "docs: a (out of date), b (not built)\nkit: d (out of date)",
    });
    expect(checkedOutcome([offline])).toEqual({
      kind: "warning",
      message: "1 member's source couldn't be reached, so it wasn't checked. The rest are up to date.",
      detail: "solo: e (not checked)",
    });
    expect(checkedOutcome([kit, offline])).toEqual({
      kind: "warning",
      message: "1 member of kit needs Sync. 1 member's source couldn't be reached, so it wasn't checked.",
      detail: "kit: d (out of date)\nsolo: e (not checked)",
    });
  });

  it("says what a session makes of each kind of clash, in full and in short", () => {
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

    expect(clashShort({ ...clash, outcome: "prefixed", sessionName: "kit:grilling" })).toBe("In a session: /kit:grilling");
    expect(clashShort({ ...clash, outcome: "hidden", sessionName: null })).toBe("Won't load: global skill turned off");
    expect(clashShort({ ...clash, with: "prompt", outcome: "shadows", sessionName: "grilling" })).toBe("Hides your global /grilling");
    expect(clashShort({ ...clash, type: "agent", with: "agent", outcome: "unknown", sessionName: null })).toBe("Same name as a global agent");
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

  it("reports a loadout's sync by what it updated, moved and removed, what failed, or that nothing needed it", () => {
    const ref = (name: string, type: "skill" | "prompt" = "skill") => ({ type, name, catalog: "team" });
    const synced = (name: string, type: "skill" | "prompt" = "skill") => ({ ...ref(name, type), dest: `/l/${name}`, preview: { kind: "destination-only" as const } });
    const gone = (name: string, type: "skill" | "prompt" = "skill") => ({ type, name, dest: `/old/${name}` });
    const loadout = (part: object) => ({ name: "review", synced: [], upToDate: [], failed: [], removed: [], ...part });

    expect(syncedOutcome("review", loadout({ synced: [synced("a"), synced("p", "prompt")], removed: [gone("p", "prompt"), gone("old")] }))).toEqual({
      kind: "success",
      message: "Synced review: 1 updated, 1 moved, 1 removed.",
    });
    expect(syncedOutcome("review", loadout({ synced: [synced("a")], failed: [{ ...ref("b"), reason: "clone failed" }] }))).toEqual({
      kind: "warning",
      message: "Synced review: 1 updated, but 1 didn't update.",
      detail: "b: clone failed",
    });
    expect(syncedOutcome("review", loadout({ upToDate: [{ ...ref("a"), status: "up-to-date" }] }))).toEqual({ kind: "success", message: "review is already up to date." });
    expect(syncedOutcome("review", undefined)).toEqual({ kind: "success", message: "review is already up to date." });
  });
});

