import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { loadRegistry } from "../registry/registry.ts";
import { applyLocalWrite, planLocalWrite } from "./local.ts";

const catalog = "library:\n  skills:\n    - name: a\n      description: A\n      source: /s/a/SKILL.md\n  agents: []\n  prompts: []\n";
const entry = { type: "skill" as const, name: "b", description: "B", source: "/s/b/SKILL.md", requires: [] };

async function setup() {
  const sb = await createSandbox();
  const file = join(sb.root, "mine.yaml");
  await writeFile(file, catalog);
  const registry = await loadRegistry(sb.host, {
    version: 1,
    catalogs: [
      { id: "mine", kind: "local", path: file },
      { id: "team", kind: "remote", repo: "git@github.com:o/r.git", yamlPath: "library.yaml", branch: "main", protected: true },
    ],
    pins: {},
    settings: {},
  });
  return { sb, file, mine: registry.catalogs()[0]!, team: registry.catalogs()[1]! };
}

describe("local write mode", () => {
  it("WRITE-14 (rebuild): writes the file in place and never runs git", async () => {
    const { sb, file, mine } = await setup();
    // Even inside a git work tree, as a catalog in a dotfiles repo would be.
    execFileSync("git", ["init", "-q", sb.root], { env: { ...process.env, ...sb.gitEnv } });
    const plan = await planLocalWrite(sb.host, mine, { op: "add", entries: [entry] });
    if (!plan.ok) throw new Error(plan.error.message);
    expect(await applyLocalWrite(sb.host, mine, plan.value)).toEqual({
      ok: true,
      value: { mode: "local", catalog: "mine", changed: true, path: file, committed: false, pushed: false, branch: null },
      warnings: [],
    });
    expect(await readFile(file, "utf8")).toContain("- name: b");
    expect(sb.audit.filter((e) => e.kind === "proc:start")).toEqual([]);
  });

  it("WRITE-17: a dry run returns the diff, named by the file's basename, and writes nothing", async () => {
    const { sb, file, mine } = await setup();
    const plan = await planLocalWrite(sb.host, mine, { op: "add", entries: [entry] }, { dryRun: true });
    if (!plan.ok) throw new Error(plan.error.message);
    const res = await applyLocalWrite(sb.host, mine, plan.value);
    expect(res).toMatchObject({ ok: true, value: { mode: "local", committed: false, pushed: false, diff: expect.stringMatching(/^--- a\/mine\.yaml\n\+\+\+ b\/mine\.yaml\n/) } });
    expect(await readFile(file, "utf8")).toBe(catalog);
  });

  it("refuses a remote catalog, and a file changed since planning", async () => {
    const { sb, file, mine, team } = await setup();
    expect(await planLocalWrite(sb.host, team, { op: "add", entries: [entry] })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    const plan = await planLocalWrite(sb.host, mine, { op: "add", entries: [entry] });
    if (!plan.ok) throw new Error(plan.error.message);
    await writeFile(file, catalog + "# meanwhile\n");
    expect(await applyLocalWrite(sb.host, mine, plan.value)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
  });
});
