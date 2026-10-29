import { describe, expect, it } from "vitest";
import type { PlanItem } from "../install/plan.ts";
import { catalogRow, entryRecord, pinRecord } from "./seeds.ts";
import { addConsequences, discardsEdits, entryEdits, groupByName, requirableRefs } from "./views.ts";

describe("groupByName", () => {
  it("moves each name's copies up to its first copy, keeping list order otherwise", () => {
    const records = [
      entryRecord({ name: "x", catalog: "A", overrides: ["B"] }),
      entryRecord({ name: "lint", catalog: "A" }),
      entryRecord({ name: "x", catalog: "B", overriddenBy: "A" }),
      entryRecord({ name: "tidy", catalog: "B" }),
    ];
    expect(groupByName(records).map((r) => `${r.name}@${r.catalog}`)).toEqual(["x@A", "x@B", "lint@A", "tidy@B"]);
  });
});

describe("requirableRefs", () => {
  it("DEP-02: offers only the catalog's own entries, sorted, without the entry itself", () => {
    const records = [
      entryRecord({ name: "tidy", catalog: "A" }),
      entryRecord({ type: "prompt", name: "style", catalog: "A" }),
      entryRecord({ name: "lint", catalog: "A" }),
      entryRecord({ name: "other", catalog: "B" }),
    ];
    expect(requirableRefs(records, "A", "skill:tidy")).toEqual(["prompt:style", "skill:lint"]);
    expect(requirableRefs(records, "A")).toEqual(["prompt:style", "skill:lint", "skill:tidy"]);
  });
});

describe("addConsequences", () => {
  const catalogs = [catalogRow({ id: "A" }), catalogRow({ id: "B", precedence: 2 }), catalogRow({ id: "C", precedence: 3, skipped: "not cloned yet", entries: null })];

  it("splits the other holders by precedence and blocks a name the catalog already holds", () => {
    const records = [entryRecord({ name: "x", catalog: "A" }), entryRecord({ name: "x", catalog: "C" }), entryRecord({ name: "y", catalog: "B" })];
    expect(addConsequences({ records, catalogs, pins: [] }, "x", "B")).toEqual({ blocked: false, overrides: [], overriddenBy: ["A"] });
    expect(addConsequences({ records, catalogs, pins: [] }, "y", "A")).toEqual({ blocked: false, overrides: ["B"], overriddenBy: [] });
    expect(addConsequences({ records, catalogs, pins: [] }, "y", "B")).toEqual({ blocked: true, overrides: [], overriddenBy: [] });
    expect(addConsequences({ records, catalogs, pins: [] }, "X", "B")).toEqual({ blocked: false, overrides: [], overriddenBy: [] });
  });

  it("lets a pin outrank precedence, as planAdd's override warnings do", () => {
    const records = [entryRecord({ name: "x", catalog: "B" })];
    expect(addConsequences({ records, catalogs, pins: [pinRecord({ name: "x", catalog: "B" })] }, "x", "A")).toEqual({ blocked: false, overrides: [], overriddenBy: ["B"] });
    const pinnedHere = [entryRecord({ name: "x", catalog: "A" })];
    expect(addConsequences({ records: pinnedHere, catalogs, pins: [pinRecord({ name: "x", catalog: "B" })] }, "x", "B")).toEqual({ blocked: false, overrides: ["A"], overriddenBy: [] });
  });
});

describe("entryEdits", () => {
  const copy = { description: "Tidies", source: "https://x/SKILL.md", requires: ["skill:lint", "prompt: style"] };

  it("is null when nothing changes, whitespace and requires order included", () => {
    expect(entryEdits(copy, { description: " Tidies ", source: "https://x/SKILL.md", requires: ["prompt:style", "skill:lint"] })).toBeNull();
  });

  it("names only the fields that change, requires as the whole sorted list", () => {
    expect(entryEdits(copy, { ...copy, description: "Tidies code" })).toEqual({ setDescription: "Tidies code" });
    expect(entryEdits(copy, { ...copy, source: "https://y/SKILL.md", requires: ["skill:lint"] })).toEqual({ setSource: "https://y/SKILL.md", setRequires: ["skill:lint"] });
    expect(entryEdits(copy, { ...copy, requires: [] })).toEqual({ setRequires: [] });
  });
});

describe("discardsEdits", () => {
  const item = (name: string, extra: Partial<PlanItem>) => ({ name, status: "ready", state: "installed", ...extra }) as PlanItem;

  it("gates on ready items over a copy the user edited, not on unmanaged or unreachable ones", () => {
    const plan = {
      items: [
        item("a", { state: "drifted" }),
        item("b", {}),
        item("c", { state: "unmanaged", needsConsent: true }),
        item("d", { state: "drifted", status: "unreachable" }),
      ],
    };
    expect(discardsEdits(plan).map((i) => i.name)).toEqual(["a"]);
    expect(discardsEdits({ items: [item("b", {})] })).toEqual([]);
  });
});
