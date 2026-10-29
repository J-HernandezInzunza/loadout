import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef, CoreError, Result } from "../model/model.ts";
import { destFor } from "../scan/scan.ts";
import { createLibrary } from "./library.ts";
import { ops } from "./schemas.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** A local skill source under the sandbox home. */
const at = (name: string) => `~/src/${name}/SKILL.md`;
const skills = (...entries: [name: string, source: string][]) =>
  `library:\n  skills:\n${entries.map(([n, src]) => `    - name: ${n}\n      description: ${n}\n      source: ${src}\n`).join("")}  agents:\n  prompts:\n`;

async function setup(catalogs: Record<string, string>, extra: CatalogRef[] = []) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const refs: CatalogRef[] = [];
  for (const [id, text] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, text);
    refs.push({ id, kind: "local", path });
  }
  await createConfigStore(sb.host).saveConfig({ version: 1, catalogs: [...refs, ...extra], pins: {}, settings: {} });
  const library = createLibrary(sb.host, { git: createGitClient(sb.host) });
  const src = (name: string) => join(sb.host.paths.home, "src", name, "SKILL.md");
  const tmp = () => readdir(join(sb.host.paths.appData, "tmp")).catch(() => []);
  return { sb, h, library, src, tmp, file: (id: string) => join(sb.root, `${id}.yaml`) };
}

/** The op's value, checked against the op's output schema. */
function value<T, E extends CoreError>(r: Result<T, E>, schema: { safeParse(v: unknown): { success: boolean } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expect(schema.safeParse(r.value).success).toBe(true);
  return r.value;
}

describe("facade: authoring", () => {
  it("planAdd + applyCatalogEdit add an entry in the catalog's write mode; a name already there is DUPLICATE", async () => {
    const { library, src, file } = await setup({ A: skills() });
    await put(src("new"));
    const plan = value(await library.planAdd({ entries: [{ name: "new", description: "N", source: src("new") }] }), ops.planAdd.output);
    expect(plan.op).toBe("add");
    const res = value(await library.applyCatalogEdit(plan), ops.applyCatalogEdit.output);
    expect(res).toMatchObject({ op: "add", mode: "local", catalog: "A", changed: true, added: [{ type: "skill", name: "new" }] });
    expect(await readFile(file("A"), "utf8")).toContain("- name: new");

    expect(await library.planAdd({ entries: [{ name: "new", description: "N", source: src("new") }] })).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE" },
    });
  });

  it("planUpdate + applyCatalogEdit change an entry's fields; an unknown name is NOT_FOUND", async () => {
    const { library, file } = await setup({ A: skills(["a", at("a")]) });
    const plan = value(await library.planUpdate({ name: "a", setDescription: "better" }), ops.planUpdate.output);
    expect(value(await library.applyCatalogEdit(plan), ops.applyCatalogEdit.output)).toMatchObject({ op: "update", name: "a", changed: true });
    expect(await readFile(file("A"), "utf8")).toContain("description: better");
    expect(await library.planUpdate({ name: "nope", setDescription: "x" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("planRemove + applyCatalogEdit remove an entry; a name two catalogs hold is AMBIGUOUS_CATALOG", async () => {
    const { library, file } = await setup({ A: skills(["a", at("a")], ["b", at("b")]), B: skills(["b", at("b")]) });
    const plan = value(await library.planRemove({ name: "a" }), ops.planRemove.output);
    expect(value(await library.applyCatalogEdit(plan), ops.applyCatalogEdit.output)).toMatchObject({
      op: "remove",
      removed: { type: "skill", name: "a" },
      dependents: [],
      deleted: [],
    });
    expect(await readFile(file("A"), "utf8")).not.toContain("- name: a\n");
    expect(await library.planRemove({ name: "b" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_CATALOG" } });
  });

  it("a PR-mode plan discarded through the facade leaves no temp dir", async () => {
    const team: CatalogRef = { id: "team", kind: "remote", repo: "https://github.com/o/cat.git", branch: "main", yamlPath: "library.yaml", protected: true };
    const { sb, h, library, tmp } = await setup({}, [team]);
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": skills() });
    value(await library.refresh(), ops.refresh.output);
    const source = "https://github.com/o/s/blob/main/n/SKILL.md";
    const plan = value(await library.planAdd({ entries: [{ name: "n", description: "N", source }] }), ops.planAdd.output);
    expect(plan.write.mode).toBe("pr");
    expect(await tmp()).not.toEqual([]);
    value(await library.discardCatalogEdit(plan), ops.discardCatalogEdit.output);
    expect(await tmp()).toEqual([]);
    expect(sb.audit.some((e) => e.kind === "proc:start" && e.argv.includes("push"))).toBe(false);
  });

  it("planPush + applyPush send an installed copy's edits back to a local source; a name not installed is refused", async () => {
    const { sb, library, src } = await setup({ A: skills(["a", at("a")], ["b", at("b")]) });
    await put(src("a"), "original\n");
    const install = value(await library.planInstall({ names: ["a"] }), ops.planInstall.output);
    value(await library.applyInstall(install), ops.applyInstall.output);
    await writeFile(join(destFor(sb.host.paths.home, "skill", "a"), "SKILL.md"), "edited\n");

    const plan = value(await library.planPush({ name: "a" }), ops.planPush.output);
    expect(value(await library.applyPush(plan), ops.applyPush.output)).toMatchObject({ kind: "local", name: "a", changed: true });
    expect(await readFile(src("a"), "utf8")).toBe("edited\n");
    expect(value(await library.discardPush(plan), ops.discardPush.output)).toBeUndefined();

    expect(await library.planPush({ name: "b" })).toMatchObject({ ok: false });
  });

  it("planPin + applyPin pin a name to a catalog and unpin hands it back; RES-13: an unknown catalog is refused", async () => {
    const { library } = await setup({ A: skills(["x", at("x")]), B: skills(["x", at("x")]) });
    const plan = value(await library.planPin({ name: "x", catalog: "B" }), ops.planPin.output);
    const pinned = value(await library.applyPin(plan, { switchInstalled: false }), ops.applyPin.output);
    expect(pinned).toMatchObject({ name: "x", catalog: "B", previous: null, holders: ["A", "B"], installed: null });
    expect(value(await library.pins(), ops.pins.output)).toMatchObject([{ name: "x", catalog: "B", resolvesTo: "B" }]);
    expect(await library.planPin({ name: "x", catalog: "C" })).toMatchObject({ ok: false });

    expect(value(await library.unpin("x"), ops.unpin.output)).toEqual({ name: "x", was: "B", resolvesTo: "A" });
    expect(await library.unpin("x")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("suggestSource gives the browser URL of a file in a GitHub repo, and says why there is none outside one", async () => {
    const { sb, h, library } = await setup({ A: skills() });
    const dir = join(sb.root, "work/lib");
    await put(join(dir, "skills/a/SKILL.md"));
    h.git(["init", "-q", "-b", "main", dir]);
    h.git(["remote", "add", "origin", "git@github.com:o/lib.git"], { cwd: dir });
    expect(value(await library.suggestSource(join(dir, "skills/a/SKILL.md")), ops.suggestSource.output)).toEqual({
      url: "https://github.com/o/lib/blob/main/skills/a/SKILL.md",
      why: "",
    });
    const outside = value(await library.suggestSource(join(sb.root, "nowhere.md")), ops.suggestSource.output);
    expect(outside.url).toBeNull();
    expect(outside.why).not.toBe("");
  });
});
