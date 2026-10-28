import { describe, expect, it } from "vitest";
import { expected, expectedReplay, loadGolden, replaySplice, type SpliceCase, type SpliceImpl } from "../../test/golden.ts";
import { assertSpliceable, renderEntry, spliceEntry, validateRef } from "./splice.ts";

const fixture = loadGolden("splice");
const notYet = () => {
  throw new Error("not implemented");
};
const impl: SpliceImpl = { renderEntry, spliceEntry, removeEntry: notYet, replaceEntry: notYet };
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

describe("assertSpliceable", () => {
  // Inserts into a missing section that D1 refuses because the section before it fails D2 are M1.09's.
  const unsupported = fixture.cases.filter((c) => {
    const e = expected(c);
    return "error" in e && e.error.code === "SPLICE_UNSUPPORTED" && targetExists(c);
  });
  // Remove and replace land in M1.10 and M1.11; until then their cases reach the layout check directly.
  const checkOnly: SpliceImpl = {
    ...impl,
    removeEntry: (text, type) => (assertSpliceable(text, type), notYet()),
    replaceEntry: (text, type) => (assertSpliceable(text, type), notYet()),
  };

  it("has the 28 cases the rebuild refuses up front in an existing section", () => {
    expect(unsupported).toHaveLength(28);
  });

  it.each(byCase(unsupported))("EDIT-09: refuses %s with SPLICE_UNSUPPORTED and its line", (_, c) => {
    expect(replaySplice(fixture, c, checkOnly)).toEqual(expectedReplay(c));
  });

  it("EDIT-09: accepts a comment after the section header", () => {
    expect(() => assertSpliceable("library:\n  skills: # mine\n    - name: a\n", "skill")).not.toThrow();
  });
});
