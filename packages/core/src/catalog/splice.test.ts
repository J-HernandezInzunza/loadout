import { describe, expect, it } from "vitest";
import { expected, expectedReplay, loadGolden, replaySplice, type FixtureEntry, type SpliceCase, type SpliceImpl } from "../../test/golden.ts";
import { removeEntry, renderEntry, replaceEntry, spliceEntry, validateRef } from "./splice.ts";

const fixture = loadGolden("splice");
const impl: SpliceImpl = { renderEntry, spliceEntry, removeEntry, replaceEntry };
const renderCases = fixture.cases.filter((c) => c.id.startsWith("render/"));

describe("renderEntry", () => {
  it("EDIT-01: has render cases to replay", () => {
    expect(renderCases).toHaveLength(8);
  });

  it.each(renderCases.map((c) => [c.id, c] as const))("EDIT-01, DEP-11: %s", (_, c) => {
    expect(replaySplice(fixture, c, impl)).toMatchObject(expected(c));
  });
});

const invalid = (message: string) => ({ code: "INVALID_REF", message });

describe("validateRef", () => {
  it.each(["skill:alpha", "agent:reviewer", "prompt:commit-style", "skill:café"])("DEP-11: accepts %s", (ref) => {
    expect(() => validateRef(ref)).not.toThrow();
  });

  it.each(["alpha", "tool:alpha", "skill:", ":alpha", "Skill:alpha"])("DEP-11: refuses %s as not type:name", (ref) => {
    expect(() => validateRef(ref)).toThrow(expect.objectContaining(invalid(`invalid requires ref '${ref}' (expected type:name)`)));
  });

  it.each([
    ['skill:a"b', `invalid requires ref 'skill:a"b'`],
    ["skill:a\\b", "invalid requires ref 'skill:a\\\\b'"],
    ["skill:a\tb", "invalid requires ref 'skill:a\\tb'"],
    ["skill:a\x7fb", "invalid requires ref 'skill:a\\x7fb'"],
    [`skill:it's"`, `invalid requires ref 'skill:it\\'s"'`],
  ])("DEP-11: refuses %j, which would render as invalid YAML", (ref, message) => {
    expect(() => validateRef(ref)).toThrow(expect.objectContaining(invalid(message)));
  });
});

// Inserts into sections that exist, where the rebuild writes what library.py writes.
const inserts = fixture.cases.filter((c) => c.text !== null && !c.rebuild && c.ops.every((o) => o.op === "splice"));
const byCase = (cases: SpliceCase[]) => cases.map((c) => [c.id, c] as const);
const PLURAL = { skill: "skills", agent: "agents", prompt: "prompts" } as const;
/** Whether the section of the case's first op is already in its text. */
const targetExists = (c: SpliceCase) => {
  const op = c.ops[0]!;
  const type = "type" in op ? op.type : op.entry.type;
  return new RegExp(`^  ${PLURAL[type]}:`, "m").test(fixture.texts[c.text!]!.text);
};
const replays = (c: SpliceCase) => expect(replaySplice(fixture, c, impl)).toMatchObject(expectedReplay(c));

describe("spliceEntry", () => {
  it("has the 309 insert cases library.py and the rebuild agree on", () => {
    expect(inserts).toHaveLength(309);
  });

  it.each(byCase(inserts.filter((c) => !c.id.endsWith("/insert-batch"))))("EDIT-08: %s", (_, c) => replays(c));

  it.each(byCase(inserts.filter((c) => c.id.endsWith("/insert-batch"))))("EDIT-13: batch %s", (_, c) => {
    expect(c.ops.length).toBeGreaterThan(1);
    replays(c);
  });

  it.each(byCase(inserts.filter((c) => c.text === "d1-library-comment")))(
    "EDIT-04: a comment after library: hides the key (%s)",
    (_, c) => {
      expect(expected(c)).toEqual({ error: { message: "no 'library:' key in catalog" } });
      replays(c);
    },
  );

  it.each(byCase(inserts.filter((c) => ["d1-top-level-after", "py-trailing-blank", "py-commented-section"].includes(c.text!))))(
    "EDIT-06: the section ends at the next key, past blank lines (%s)",
    (_, c) => replays(c),
  );

  it.each(byCase(inserts.filter((c) => c.text === "py-quoted")))("EDIT-07: quoted names are names (%s)", (_, c) => replays(c));

  it("EDIT-08: refuses a duplicate with DUPLICATE", () => {
    const c = inserts.find((c) => c.id === "py-quoted/skills/0:yaml-lint/insert-duplicate")!;
    expect(replaySplice(fixture, c, impl)).toEqual({ error: { code: "DUPLICATE", message: "'yaml-lint' already exists in skills" } });
  });
});

describe("unsupported layouts", () => {
  const unsupported = fixture.cases.filter((c) => {
    const e = expected(c);
    return "error" in e && e.error.code === "SPLICE_UNSUPPORTED";
  });

  it("has the 48 cases the rebuild refuses up front", () => {
    expect(unsupported).toHaveLength(48);
  });

  it.each(byCase(unsupported))("EDIT-09: refuses %s with SPLICE_UNSUPPORTED and its line", (_, c) => {
    expect(replaySplice(fixture, c, impl)).toEqual(expectedReplay(c));
  });

  it("EDIT-09: accepts a comment after the section header", () => {
    const entry: FixtureEntry = { type: "skill", name: "b", description: "B", source: "./b", requires: [] };
    expect(() => spliceEntry("library:\n  skills: # mine\n    - name: a\n", entry)).not.toThrow();
  });
});

describe("spliceEntry into a missing section", () => {
  const missing = fixture.cases.filter((c) => c.text !== null && !targetExists(c));

  it("has the 168 cases whose text lacks the target section", () => {
    expect(missing).toHaveLength(168);
  });

  it.each(byCase(missing))("EDIT-05: %s", (_, c) => {
    expect(replaySplice(fixture, c, impl)).toMatchObject(expectedReplay(c));
  });

  it("EDIT-05: creates the section after the one before it in canonical order", () => {
    const text = "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n\n  prompts: []\n";
    const entry: FixtureEntry = { type: "agent", name: "r", description: "R", source: "./r", requires: [] };
    expect(spliceEntry(text, entry)).toBe(
      "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n  agents:\n    - name: r\n      description: R\n      source: ./r\n\n  prompts: []\n",
    );
  });
});

describe("removeEntry", () => {
  const removes = fixture.cases.filter((c) => c.ops.some((o) => o.op === "remove"));
  const commented = ["r-spaced-commented", "py-commented-item", "py-commented-section"];

  it("has the 330 cases with a remove, round trips included", () => {
    expect(removes).toHaveLength(330);
  });

  it.each(byCase(removes))("EDIT-10: %s", (_, c) => replays(c));

  it.each(byCase(removes.filter((c) => commented.includes(c.text!))))(
    "EDIT-11: comments outside the item's own lines stay (%s)",
    (_, c) => replays(c),
  );

  it("EDIT-10: refuses an unknown name with NOT_FOUND", () => {
    expect(() => removeEntry("library:\n  skills: []\n", "skill", "x")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND", message: "'x' not found in skills" }),
    );
  });
});

describe("replaceEntry", () => {
  const replaces = fixture.cases.filter((c) => c.ops.some((o) => o.op === "replace"));

  it.each(byCase(replaces))("EDIT-12: %s", (_, c) => replays(c));

  it("EDIT-12: keeps the name line, unknown keys, comments and blanks, and edits fields in place", () => {
    const text = [
      "library:",
      "  skills:",
      "    - name: beta",
      "      # why beta",
      "      description: B",
      "      tags: [x]",
      "",
      "      source: ./beta",
      "    - name: gamma",
      "      description: C",
      "      source: ./gamma",
      "",
    ].join("\n");
    const entry: FixtureEntry = { type: "skill", name: "ignored", description: "B2", source: "./b2", requires: ["skill:gamma"] };
    expect(replaceEntry(text, "skill", "beta", entry).split("\n").slice(2, 10)).toEqual([
      "    - name: beta",
      "      # why beta",
      "      description: B2",
      "      tags: [x]",
      "",
      "      source: ./b2",
      '      requires: ["skill:gamma"]',
      "    - name: gamma",
    ]);
  });
});

describe("the splice corpus", () => {
  it("replays all 896 cases as the rebuild expects", () => {
    const failing = fixture.cases.filter((c) => {
      try {
        expect(replaySplice(fixture, c, impl)).toMatchObject(expectedReplay(c));
        return false;
      } catch {
        return true;
      }
    });
    expect(fixture.cases).toHaveLength(896);
    expect(failing.map((c) => c.id)).toEqual([]);
  });
});
