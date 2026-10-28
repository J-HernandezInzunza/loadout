import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { catalogEntries, parseCatalog, verifyEdit } from "./read.ts";
import { scaffoldCatalog } from "./scaffold.ts";
import { spliceEntry } from "./splice.ts";

const data = (text: string) => {
  const parsed = parseCatalog(text);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  return parsed.data;
};

describe("scaffoldCatalog", () => {
  it("EDIT-15: parses to three empty sections, as the CLI's scaffold does", () => {
    const text = scaffoldCatalog("personal");
    const cli = loadGolden("splice").texts["scaffold"]!.text;
    expect(data(text)).toEqual({ library: { skills: [], agents: [], prompts: [] } });
    expect(data(text)).toEqual(data(cli));
    expect(catalogEntries(data(text), "personal")).toEqual({ entries: [], problems: [] });
  });

  it.each(["skill", "agent", "prompt"] as const)("EDIT-15: accepts an insert into its %s section", (type) => {
    const text = spliceEntry(scaffoldCatalog("personal"), { type, name: "x", description: "X", source: "./x", requires: [] });
    expect(() => verifyEdit(text, { type, name: "x" }, true)).not.toThrow();
  });

  it("EDIT-15: keeps a catalog id with a line break inside its comment", () => {
    expect(data(scaffoldCatalog("a\nlibrary: 7"))).toEqual({ library: { skills: [], agents: [], prompts: [] } });
  });
});
