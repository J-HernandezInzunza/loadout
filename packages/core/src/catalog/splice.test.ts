import { describe, expect, it } from "vitest";
import { expected, loadGolden, replaySplice, type SpliceImpl } from "../../test/golden.ts";
import { renderEntry, validateRef } from "./splice.ts";

const fixture = loadGolden("splice");
const notYet = () => {
  throw new Error("not implemented");
};
const impl: SpliceImpl = { renderEntry, spliceEntry: notYet, removeEntry: notYet, replaceEntry: notYet };
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
