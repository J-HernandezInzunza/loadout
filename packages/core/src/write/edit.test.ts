import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { applyCatalogEdit, computeEdit, inPlaceResult, planCatalogEdit } from "./edit.ts";
import { unifiedDiff } from "./diff.ts";

const catalog = `library:
  skills:
    - name: alpha
      description: First
      source: /s/alpha/SKILL.md
    - name: beta
      description: Second
      source: /s/beta/SKILL.md
      requires: ["prompt:p"]
  agents: []
  prompts:
    - name: p
      description: A prompt
      source: /p.md
`;
const entry = (name: string) => ({ type: "skill" as const, name, description: `About ${name}`, source: `/s/${name}/SKILL.md`, requires: [] });

async function setup(text = catalog) {
  const sb = await createSandbox();
  const file = join(sb.root, "library.yaml");
  await writeFile(file, text);
  return { sb, file, target: { file, displayName: "library.yaml" } };
}

describe("computeEdit", () => {
  it("EDIT-13: a batch of adds lands as one text, each verified present", () => {
    const res = computeEdit(catalog, { op: "add", entries: [entry("gamma"), entry("aardvark")] });
    expect(res.ok && res.value.changed).toBe(true);
    expect(res.ok && res.value.text).toContain("- name: aardvark");
    expect(res.ok && res.value.text.indexOf("aardvark") < res.value.text.indexOf("alpha")).toBe(true);
  });

  it("WRITE-15: an update reads the entry from the text it edits, so an upstream change survives", () => {
    // The registry once saw beta's description as "Second"; upstream has changed it since.
    const upstream = catalog.replace("description: Second", "description: Second, improved upstream");
    const res = computeEdit(upstream, { op: "update", type: "skill", name: "beta", fields: { source: "/s/beta2/SKILL.md" } });
    expect(res.ok && res.value.text).toContain("description: Second, improved upstream");
    expect(res.ok && res.value.text).toContain("source: /s/beta2/SKILL.md");
    expect(res.ok && res.value.text).toContain('requires: ["prompt:p"]');
  });

  it("WRITE-15: the no-op test compares fields, not bytes", () => {
    const quoted = catalog.replace("description: First", "description: 'First'");
    expect(computeEdit(quoted, { op: "update", type: "skill", name: "alpha", fields: { description: "First", requires: [] } })).toEqual({
      ok: true,
      value: { text: quoted, changed: false },
      warnings: [],
    });
  });

  it("WRITE-16: refuses an edit that wouldn't produce a valid catalog holding (or not holding) the entry", () => {
    expect(computeEdit(catalog, { op: "add", entries: [{ ...entry("x"), description: "two\nlines" }] })).toMatchObject({ ok: false, error: { code: "MULTILINE_VALUE" } });
    expect(computeEdit(catalog, { op: "remove", type: "agent", name: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const removed = computeEdit(catalog, { op: "remove", type: "prompt", name: "p" });
    expect(removed.ok && removed.value.text).not.toContain("name: p\n");
  });
});

describe("plan and apply", () => {
  it("WRITE-17: a dry run carries a unified diff and writes nothing", async () => {
    const { sb, file, target } = await setup();
    const plan = await planCatalogEdit(sb.host, target, { op: "update", type: "skill", name: "alpha", fields: { description: "First, better" } }, { dryRun: true });
    expect(plan.ok && plan.value.diff).toBe(
      "--- a/library.yaml\n+++ b/library.yaml\n@@ -1,7 +1,7 @@\n" +
        " library:\n   skills:\n     - name: alpha\n-      description: First\n+      description: First, better\n" +
        "       source: /s/alpha/SKILL.md\n     - name: beta\n       description: Second\n",
    );
    expect(await readFile(file, "utf8")).toBe(catalog);
  });

  it("LOCK-03 (A32): writes atomically, and refuses a file that changed after planning", async () => {
    const { sb, file, target } = await setup();
    const plan = await planCatalogEdit(sb.host, target, { op: "add", entries: [entry("gamma")] });
    if (!plan.ok) throw new Error(plan.error.message);
    await writeFile(file, catalog + "# edited by hand\n");
    expect(await applyCatalogEdit(sb.host, plan.value)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    expect(await readFile(file, "utf8")).toBe(catalog + "# edited by hand\n");

    const fresh = await planCatalogEdit(sb.host, target, { op: "add", entries: [entry("gamma")] });
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(await applyCatalogEdit(sb.host, fresh.value)).toEqual({ ok: true, value: { path: file, changed: true }, warnings: [] });
    expect(await readFile(file, "utf8")).toContain("- name: gamma");
    expect((await readdir(sb.root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(sb.audit).toContainEqual({ kind: "fs", op: "write", path: file });
  });

  it("WRITE-15: a no-op writes nothing", async () => {
    const { sb, target } = await setup();
    const plan = await planCatalogEdit(sb.host, target, { op: "update", type: "skill", name: "alpha", fields: { description: "First" } });
    if (!plan.ok) throw new Error(plan.error.message);
    expect(await applyCatalogEdit(sb.host, plan.value)).toMatchObject({ ok: true, value: { changed: false } });
    expect(sb.audit.filter((e) => e.kind === "fs")).toEqual([]);
  });

  it("WRITE-18: an in-place result reports mode, catalog, path, git outcome and branch, plus the diff of a dry run", async () => {
    const { sb, file, target } = await setup();
    const plan = await planCatalogEdit(sb.host, target, { op: "remove", type: "prompt", name: "p" });
    if (!plan.ok) throw new Error(plan.error.message);
    expect(inPlaceResult("local", "mine", plan.value, { committed: false, pushed: false, branch: null })).toEqual({
      mode: "local",
      catalog: "mine",
      changed: true,
      path: file,
      committed: false,
      pushed: false,
      branch: null,
    });
    const dry = await planCatalogEdit(sb.host, target, { op: "remove", type: "prompt", name: "p" }, { dryRun: true });
    if (!dry.ok) throw new Error(dry.error.message);
    expect(inPlaceResult("direct", "team", dry.value, { committed: false, pushed: false, branch: "main" })).toMatchObject({ mode: "direct", branch: "main", diff: expect.stringMatching(/^--- a\/library\.yaml\n/) });
  });
});

describe("unifiedDiff", () => {
  it("matches difflib's ranges for insertions at the start, deletions at the end, and separate hunks", () => {
    expect(unifiedDiff("f", "a\nb\n", "a\nb\n")).toBe("");
    expect(unifiedDiff("f", "a\n", "x\na\n")).toBe("--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n+x\n a\n");
    expect(unifiedDiff("f", "", "x\n")).toBe("--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+x\n");
    expect(unifiedDiff("f", "a\nb\n", "a\n")).toBe("--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n a\n-b\n");
    const before = Array.from({ length: 20 }, (_, i) => `l${i}\n`).join("");
    const after = before.replace("l1\n", "L1\n").replace("l18\n", "L18\n");
    expect(unifiedDiff("f", before, after).match(/^@@/gm)).toHaveLength(2);
    expect(unifiedDiff("f", "a", "b")).toBe("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n");
  });
});
