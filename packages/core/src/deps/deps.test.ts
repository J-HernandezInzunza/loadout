import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { catalogEntries, parseCatalog } from "../catalog/read.ts";
import type { Entry, EntryType } from "../model/model.ts";
import { dependents, findCycles, mergeOrders, resolveDeps } from "./deps.ts";

const read = (text: string, catalog = "A"): Entry[] => {
  const parsed = parseCatalog(text);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  return catalogEntries(parsed.data, catalog).entries;
};
const e = (type: EntryType, name: string, requires: string[] = [], catalog = "A"): Entry => ({
  type,
  name,
  description: name,
  source: `./${name}`,
  requires,
  catalog,
});
const ids = (entries: Entry[]) => entries.map((x) => `${x.type}:${x.name}`);
const find = (entries: Entry[], name: string) => entries.find((x) => x.name === name)!;

describe("resolveDeps", () => {
  it("DEP-01: dependencies first, post-order, each once (golden py-catalog)", () => {
    const entries = read(loadGolden("splice").texts["py-catalog"]!.text);
    expect(ids(resolveDeps(entries, find(entries, "gamma")).order)).toEqual(["skill:alpha", "skill:gamma"]);
  });

  it("DEP-01: walks refs in list order, each dependency's closure before it", () => {
    const entries = [
      e("skill", "p", ["skill:r1", "prompt:r2"]),
      e("skill", "r1", ["agent:d"]),
      e("prompt", "r2", ["agent:d"]),
      e("agent", "d"),
    ];
    expect(ids(resolveDeps(entries, entries[0]!).order)).toEqual(["agent:d", "skill:r1", "prompt:r2", "skill:p"]);
  });

  it("DEP-02: splits on the first colon, strips, and looks only in the given catalog's entries", () => {
    const entries = [e("skill", "p", [" skill : a:b ", "skill:elsewhere"]), e("skill", "a:b")];
    const result = resolveDeps(entries, entries[0]!);
    expect(ids(result.order)).toEqual(["skill:a:b", "skill:p"]);
    expect(result.unresolved).toEqual([{ ref: "skill:elsewhere", requiredBy: "p", reason: "not_found" }]);
  });

  it("DEP-03: skips a ref with no colon as malformed", () => {
    const entries = [e("skill", "p", ["alpha"])];
    expect(resolveDeps(entries, entries[0]!)).toEqual({
      order: [entries[0]],
      unresolved: [{ ref: "alpha", requiredBy: "p", reason: "malformed" }],
      warnings: [{ message: "malformed dependency ref 'alpha' on skill:p" }],
    });
  });

  it("DEP-04: skips a missing ref, unknown type included, as not_found (golden unicode)", () => {
    const entries = read(loadGolden("read").cases.find((c) => c.id === "unicode")!.text);
    expect(resolveDeps(entries, entries[0]!)).toEqual({
      order: [entries[0]],
      unresolved: [{ ref: "skill:日本", requiredBy: "café", reason: "not_found" }],
      warnings: [{ message: "dependency skill:日本 not found in catalog (required by café)" }],
    });
    const typed = [e("skill", "p", ["tool:x"]), e("skill", "x")];
    expect(resolveDeps(typed, typed[0]!).unresolved).toEqual([{ ref: "tool:x", requiredBy: "p", reason: "not_found" }]);
  });

  it("DEP-05: a cycle is walked once and recorded against the parent that re-entered it (A29)", () => {
    const entries = [e("skill", "a", ["skill:b"]), e("skill", "b", ["skill:a"])];
    expect(resolveDeps(entries, entries[0]!)).toEqual({
      order: [entries[1], entries[0]],
      unresolved: [{ ref: "skill:a", requiredBy: "b", reason: "cycle" }],
      warnings: [{ message: "dependency cycle detected at skill:a; skipping re-entry" }],
    });
  });

  it("DEP-05: a dependency reached twice without a cycle is not one", () => {
    const entries = [e("skill", "a", ["skill:b", "skill:c"]), e("skill", "b", ["skill:c"]), e("skill", "c")];
    expect(resolveDeps(entries, entries[0]!)).toMatchObject({ unresolved: [], warnings: [] });
  });
});

describe("mergeOrders", () => {
  it("DEP-06: merges closures in request order, each (type, name) once", () => {
    const entries = [e("skill", "a", ["skill:c"]), e("skill", "b", ["skill:c"]), e("skill", "c")];
    const orders = [entries[0]!, entries[1]!].map((t) => resolveDeps(entries, t).order);
    expect(ids(mergeOrders(orders))).toEqual(["skill:c", "skill:a", "skill:b"]);
  });
});

describe("dependents", () => {
  it("DEP-08: entries in the catalog whose closure reaches the target, direct first, then type, then name", () => {
    const entries = [
      e("skill", "z", ["skill:t"]),
      e("agent", "y", ["skill:t"]),
      e("skill", "w", ["skill:z"]),
      e("prompt", "v", ["agent:y", "bad"]),
      e("skill", "u"),
      e("skill", "t"),
    ];
    expect(dependents(entries, find(entries, "t")).map(({ entry, direct }) => [entry.name, direct])).toEqual([
      ["y", true],
      ["z", true],
      ["v", false],
      ["w", false],
    ]);
  });
});

describe("findCycles", () => {
  it("DEP-05: reports each cycle in a catalog once", () => {
    const entries = [e("skill", "a", ["skill:b"]), e("skill", "b", ["skill:a"]), e("skill", "c", ["skill:a"]), e("skill", "d")];
    expect(findCycles(entries)).toEqual([["skill:a", "skill:b", "skill:a"]]);
    expect(findCycles([e("skill", "d")])).toEqual([]);
  });
});
