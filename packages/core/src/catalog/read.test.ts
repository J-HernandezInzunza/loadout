import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import type { Entry } from "../model/model.ts";
import { catalogEntries, parseCatalog, sortedProblems, verifyEdit } from "./read.ts";

const { cases } = loadGolden("read");
const PLURAL = { skill: "skills", agent: "agents", prompt: "prompts" } as const;
type PyValue = { py: string; repr: string };
const isPy = (v: unknown): v is PyValue => typeof v === "object" && v !== null && "py" in v;

/** The TS value a PyYAML non-string reads as: bool → boolean, int/float → number, None → null, date(time) → Date. */
function declaredForm({ py, repr }: PyValue): unknown {
  const nums = (s: string) => (s.match(/-?\d+/g) ?? []).map(Number);
  switch (py) {
    case "bool":
      return repr === "True";
    case "NoneType":
      return null;
    case "int":
      return Number(repr);
    case "float":
      return { inf: Infinity, "-inf": -Infinity, nan: NaN }[repr] ?? Number(repr);
    case "date": {
      const [y, m, d] = nums(repr);
      return new Date(Date.UTC(y!, m! - 1, d!));
    }
    case "datetime": {
      const [stamp, tz = ""] = repr.split("tzinfo=");
      const [y, m, d, h = 0, mi = 0, s = 0, us = 0] = nums(stamp!);
      const [days = 0, seconds = 0] = nums(tz);
      return new Date(Date.UTC(y!, m! - 1, d!, h, mi, s, us / 1000) - (days * 86400 + seconds) * 1000);
    }
  }
  throw new Error(`no declared form for ${py}`);
}

function read(text: string) {
  const parsed = parseCatalog(text);
  if (!parsed.ok) throw new Error(`parse problem: ${parsed.problem.message}`);
  return catalogEntries(parsed.data, "team");
}

// The CLI turns `requires: skill:b` into a list of characters; the rebuild reports it instead.
const CHARACTER_LIST = "requires-scalar";
const valid = cases.flatMap((c) =>
  "entries" in c && c.id !== CHARACTER_LIST && !c.entries.some((e) => Object.values(e).some(isPy)) ? [c] : [],
);
const typedFields = cases.flatMap((c) => ("entries" in c && c.entries.some((e) => Object.values(e).some(isPy)) ? [c] : []));

describe("parseCatalog and catalogEntries", () => {
  it.each(valid.map((c) => [c.id, c] as const))("read the same entries as PyYAML: %s", (_, c) => {
    expect(read(c.text)).toEqual({ entries: c.entries.map((e) => ({ ...e, catalog: "team" })), problems: [] });
  });

  it.each(typedFields.map((c) => [c.id, c] as const))(
    "report a YAML 1.1 non-string as a field problem in its TS form: %s",
    (_, c) => {
      const { entries, problems } = read(c.text);
      expect(entries).toEqual([]);
      const seen: Record<string, number> = {};
      for (const e of c.entries) {
        const index = (seen[e.type] = (seen[e.type] ?? -1) + 1);
        for (const [field, value] of Object.entries(e)) {
          if (!isPy(value)) continue;
          expect(problems).toContainEqual(
            expect.objectContaining({ kind: "field", path: `${PLURAL[e.type]}[${index}].${field}`, field, value: declaredForm(value) }),
          );
        }
      }
    },
  );

  it("read what PyYAML leaves as text as strings, where other YAML 1.1 readers do not", () => {
    const { entries } = read("library:\n  skills:\n    - name: y\n      description: 09\n      source: 1e3\n    - name: n\n");
    expect(entries.map(({ name, description, source }) => [name, description, source])).toEqual([
      ["y", "09", "1e3"],
      ["n", "", ""],
    ]);
  });

  it("report a requires that is not a list as a field problem", () => {
    const c = cases.find((c) => c.id === CHARACTER_LIST)!;
    expect(read(c.text).problems).toEqual([
      expect.objectContaining({ kind: "field", path: "skills[0].requires", field: "requires", value: "skill:b" }),
    ]);
  });

  it("report a YAML syntax error as a parse problem with its line", () => {
    const c = cases.find((c) => c.id === "tab-indent")!;
    expect(parseCatalog(c.text)).toEqual({ ok: false, problem: expect.objectContaining({ kind: "parse", line: 2 }) });
  });

  it.each([
    ["item-is-string", "skills[0]"],
    ["section-is-mapping", "skills"],
  ])("report the shape library.py crashes on as a structure problem: %s", (id, path) => {
    const c = cases.find((c) => c.id === id)!;
    expect("error" in c).toBe(true);
    expect(read(c.text)).toEqual({ entries: [], problems: [expect.objectContaining({ kind: "structure", path })] });
  });

  it("keep the other entries when one is bad", () => {
    const { entries, problems } = read("library:\n  skills:\n    - name: yes\n    - name: ok\n  prompts:\n    - 7\n");
    expect(entries.map((e) => e.name)).toEqual(["ok"]);
    expect(problems.map((p) => p.path)).toEqual(["skills[0].name", "prompts[0]"]);
  });

  it("RES-02: list skills, then agents, then prompts, whatever the file order", () => {
    const c = cases.find((c) => c.id === "anchor-alias")!;
    expect(read(c.text).entries.map((e) => e.type)).toEqual(["skill", "prompt"]);
    const reordered = read("library:\n  prompts:\n    - name: x\n  skills:\n    - name: x\n");
    expect(reordered.entries.map((e) => e.type)).toEqual(["skill", "prompt"]);
  });
});

describe("verifyEdit", () => {
  const text = "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n";
  const a = { type: "skill", name: "a" } as const;

  it("WRITE-16: passes when an added or updated entry is present", () => {
    expect(() => verifyEdit(text, a, true)).not.toThrow();
  });

  it("WRITE-16: passes when a removed entry is absent", () => {
    expect(() => verifyEdit("library:\n  skills: []\n", a, false)).not.toThrow();
  });

  it.each([
    ["a missing entry", "library:\n  skills: []\n", true],
    ["an entry still present", text, false],
    ["text that no longer parses", "library:\n  skills: [ ]\n    - name: a\n", true],
    ["the entry under another type", text.replace("skills", "prompts"), true],
  ])("WRITE-16: aborts with VERIFY_FAILED on %s", (_, edited, present) => {
    expect(() => verifyEdit(edited, a, present)).toThrow(
      expect.objectContaining({ code: "VERIFY_FAILED", message: expect.stringMatching(/^internal error: .*; aborting$/) }),
    );
  });
});

describe("sortedProblems", () => {
  const entries = (text: string): Entry[] => read(text).entries;

  it.each(valid.map((c) => [c.id, c] as const))("EDIT-14: agrees with Python's sorted(key=str.lower): %s", (_, c) => {
    const expected = c.id === "splice:py-broken-catalog" ? ["skills not alphabetically sorted"] : [];
    expect(sortedProblems(entries(c.text))).toEqual(expected);
  });

  it("EDIT-14: compares names case-insensitively", () => {
    expect(sortedProblems(entries("library:\n  agents:\n    - name: alpha\n    - name: Beta\n    - name: charlie\n"))).toEqual([]);
    expect(sortedProblems(entries("library:\n  agents:\n    - name: beta\n    - name: Alpha\n"))).toEqual([
      "agents not alphabetically sorted",
    ]);
  });
});
