import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { parseYamlMaps } from "../catalog/read.ts";
import { validateRegistry } from "./registry.ts";

const { cases } = loadGolden("registry");

const data = (yaml: string) => {
  const parsed = parseYamlMaps(yaml);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  return parsed.data;
};

describe("validateRegistry", () => {
  it.each(cases.map((c) => [c.id, c] as const))("MIG-01: %s", (_, c) => {
    expect(validateRegistry(data(c.yaml))).toEqual(c.problems);
  });

  it("MIG-01: checks the legacy form's catalog like any other, as 'shared'", () => {
    expect(validateRegistry(data("catalog:\n  repo: r\n  yaml_path: ../x.yaml\n  branch: main\n"))).toEqual([
      "catalog 'shared' has invalid yaml_path '../x.yaml': use a relative path inside the repo (no leading '/', no '..', no ':')",
    ]);
  });
});
