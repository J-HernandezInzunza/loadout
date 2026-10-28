// Integrity of the committed golden fixtures (architecture.md §3.2). The core's own tests replay
// them from M1; this only checks they are complete and consistent, so a bad regeneration fails the
// gate even before anything consumes them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../packages/core/test/golden/", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(dir + name + ".json", "utf8"));

describe.each(["splice", "scalar", "source", "hash", "registry"])("%s fixture", (name) => {
  it("is pinned to library.py at a29e816", () => {
    const { meta } = load(name);
    expect(meta).toMatchObject({ corpus: name, library: { commit: "a29e816" }, pyyaml: "6.0.3" });
  });
});

describe("splice fixture", () => {
  const { texts, cases } = load("splice");

  it("has unique case ids and references only known texts", () => {
    const ids = cases.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) if (c.text !== null) expect(texts).toHaveProperty(c.text);
  });

  it("never expects the rebuild to write invalid YAML", () => {
    for (const c of cases) expect(c.rebuild?.yamlValid, c.id).not.toBe(false);
  });

  it("covers every Python suite splice text and the example catalog", () => {
    for (const id of ["py-catalog", "py-three", "py-single", "py-trailing-blank", "py-quoted", "example"]) {
      expect(texts).toHaveProperty(id);
    }
    expect(cases.length).toBeGreaterThan(800);
  });
});

describe("scalar fixture", () => {
  it("has thousands of distinct values, each with exactly one outcome", () => {
    const { cases } = load("scalar");
    expect(cases.length).toBeGreaterThan(4000);
    expect(new Set(cases.map((c: { value: string }) => c.value)).size).toBe(cases.length);
    for (const c of cases) expect("out" in c !== "multiline" in c, JSON.stringify(c.value)).toBe(true);
  });
});
