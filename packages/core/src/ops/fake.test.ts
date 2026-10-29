import { describe, expect, it } from "vitest";
import { checked } from "../../test/checkedLibrary.ts";
import type { EntryRecord } from "../registry/registry.ts";
import { createFakeLibrary } from "./fake.ts";
import type { Library } from "./library.ts";
import { ops } from "./schemas.ts";

const record = (name: string, catalog: string, extra: Partial<EntryRecord> = {}): EntryRecord => ({
  type: "skill",
  name,
  description: `${name} from ${catalog}`,
  source: `~/src/${name}/SKILL.md`,
  requires: [],
  catalog,
  overrides: [],
  overriddenBy: null,
  pinned: false,
  installed: false,
  state: "not_installed",
  receipt: null,
  locations: [],
  disabled: false,
  ...extra,
});

describe("in-memory Library fake", () => {
  it("implements the Library interface", () => {
    const fake: Library = createFakeLibrary();
    expect(Object.keys(fake).sort()).toEqual(Object.keys(ops).concat("state").sort());
  });

  it("answers reads from the seeded state, in the ops' schemas", async () => {
    const entries = [record("x", "A", { overrides: ["B"] }), record("x", "B", { overriddenBy: "A" }), record("lint", "A")];
    const fake = checked(createFakeLibrary({ entries }));
    const list = await fake.list();
    expect(list.ok && ops.list.output.safeParse(list.value).success).toBe(true);
    expect(await fake.search("LINT")).toMatchObject({ ok: true, value: [{ name: "lint" }] });

    const shown = await fake.show("x");
    expect(shown.ok && ops.show.output.safeParse(shown.value).success).toBe(true);
    expect(shown.ok && shown.value.copies.map((c) => [c.catalog, c.wins, c.subject])).toEqual([
      ["A", true, true],
      ["B", false, false],
    ]);
    expect(await fake.show("x", { catalog: "B" })).toMatchObject({ ok: true, value: { entry: { catalog: "B" } } });
    expect(await fake.show("nope")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("refuses mutations unless the test overrides them", async () => {
    const fake = checked(createFakeLibrary({}, { unpin: async (name) => ({ ok: true, value: { name, was: "A", resolvesTo: null }, warnings: [] }) }));
    expect(await fake.uninstall({ names: ["x"] })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await fake.unpin("x")).toMatchObject({ ok: true, value: { was: "A" } });
  });
});
