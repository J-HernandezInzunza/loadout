import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { LibraryError } from "../model/model.ts";
import { pyyamlInline } from "./scalar.ts";

const { cases } = loadGolden("scalar");

describe("pyyamlInline", () => {
  it("EDIT-02: matches PyYAML byte for byte on every scalar.json value", () => {
    const mismatches = cases.flatMap((c) => {
      if (!("out" in c)) return [];
      const out = pyyamlInline(c.value);
      return out === c.out ? [] : [{ value: c.value, expected: c.out, got: out }];
    });
    expect(mismatches).toEqual([]);
    expect(cases.filter((c) => "out" in c)).toHaveLength(4689);
  });

  it.each([
    ["a: b", "'a: b'"],
    ["yes", "'yes'"],
    ["1_000", "'1_000'"],
    ["1e3", "1e3"],
    ["", "''"],
    ["'q'", "'''q'''"],
    ["https://x/y?z#w", "https://x/y?z#w"],
    ["tab\there", '"tab\\there"'],
  ])("EDIT-02: %j is written as %s", (value, out) => {
    expect(pyyamlInline(value)).toBe(out);
  });

  it("EDIT-03: refuses every multiline value with MULTILINE_VALUE", () => {
    const multiline = cases.filter((c) => "multiline" in c);
    expect(multiline).toHaveLength(4);
    for (const c of multiline) {
      const thrown = (() => {
        try {
          pyyamlInline(c.value);
        } catch (e) {
          return e;
        }
      })();
      expect(thrown, JSON.stringify(c.value)).toBeInstanceOf(LibraryError);
      expect(thrown).toMatchObject({
        code: "MULTILINE_VALUE",
        message: "multiline values are not supported in catalog entries; keep it on one line",
      });
    }
  });

  it("EDIT-03: accepts a newline that double quoting escapes, as PyYAML does", () => {
    expect(pyyamlInline("a\r\nb")).toBe('"a\\r\\nb"');
  });
});
