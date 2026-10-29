import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { refreshCatalogs } from "../catalogs/catalogs.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef } from "../model/model.ts";
import { computeEdit } from "./edit.ts";
import { applyUpdate, planUpdate, type UpdateRequest } from "./update.ts";
import type { WriteCtx } from "./write.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const gh = (path: string) => `https://github.com/o/s/blob/main/${path}`;
const mine = `library:
  skills:
    # the review skill, kept by hand
    - name: review
      description: Reviews code
      source: ${gh("review/SKILL.md")}
      requires: ["prompt:style"]
      tags: [quality, team]
    - name: lint
      description: Lints
      source: ${gh("lint/SKILL.md")}
  agents: []
  prompts:
    - name: style
      description: House style
      source: ${gh("style.md")}
`;

async function setup(catalogs: Record<string, string> = { mine }, remotes: CatalogRef[] = []) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const config = createConfigStore(sb.host);
  const refs: CatalogRef[] = [];
  for (const [id, text] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, text);
    refs.push({ id, kind: "local", path });
  }
  await config.saveConfig({ version: 1, catalogs: [...refs, ...remotes], pins: {}, settings: {} });
  const ctx: WriteCtx = { host: sb.host, git: createGitClient(sb.host), config };
  const update = async (req: UpdateRequest) => {
    const plan = await planUpdate(ctx, req);
    if (!plan.ok) return plan;
    const applied = await applyUpdate(ctx, plan.value);
    return applied.ok ? { ...applied, warnings: [...plan.warnings, ...applied.warnings] } : applied;
  };
  const text = (id = "mine") => readFile(join(sb.root, `${id}.yaml`), "utf8");
  return { sb, h, ctx, update, text, file: (id = "mine") => join(sb.root, `${id}.yaml`) };
}

describe("update", () => {
  it("EDIT-12 (rebuild): edits fields in place, keeping unknown keys and comments, end to end", async () => {
    const { update, text } = await setup();
    expect(await update({ name: "review", setDescription: "Reviews code carefully" })).toMatchObject({ ok: true, value: { name: "review", changed: true, mode: "local" } });
    expect(await text()).toBe(mine.replace("description: Reviews code\n", "description: Reviews code carefully\n"));
  });

  it("WRITE-15: equal fields are a no-op with no write", async () => {
    const { sb, update, text } = await setup();
    expect(await update({ name: "review", setDescription: "Reviews code", setRequires: ["prompt:style"] })).toMatchObject({ ok: true, value: { changed: false } });
    expect(await text()).toBe(mine);
    expect(sb.audit.filter((e) => e.kind === "fs" && e.path.endsWith("mine.yaml"))).toEqual([]);
  });

  it("WRITE-15: adds and removes refs against the text being written, warning about redundant ones", async () => {
    const { update, text } = await setup();
    const res = await update({ name: "review", addRequires: ["skill:lint", "prompt:style"], removeRequires: ["prompt:missing"] });
    expect(res.ok && res.warnings).toEqual([{ message: "'review' already requires prompt:style" }, { message: "'review' doesn't require prompt:missing" }]);
    expect(await text()).toContain('requires: ["prompt:style", "skill:lint"]');
    await update({ name: "review", removeRequires: ["prompt:style"] });
    expect(await text()).toContain('requires: ["skill:lint"]');
    await update({ name: "review", setRequires: [] });
    expect(await text()).not.toContain("requires");
  });

  it("DEP-10: warns about a newly required ref the catalog doesn't have yet", async () => {
    const { update } = await setup();
    const res = await update({ name: "lint", addRequires: ["skill:nope", "skill:review"] });
    expect(res.ok && res.warnings).toEqual([{ message: "required dependency skill:nope is not in the catalog yet" }]);
  });

  it("WRITE-15: an entry removed upstream is reported, not resurrected; a file changed after planning is stale", async () => {
    const { ctx, file } = await setup();
    // In direct mode the pull can drop an entry the registry still lists: the edit reads the text itself.
    expect(computeEdit(mine.replace(/ {4}- name: lint\n.*\n.*\n/, ""), { op: "update", type: "skill", name: "lint", fields: { description: "x" } })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "'lint' was removed from the catalog upstream; nothing to update" },
    });
    const plan = await planUpdate(ctx, { name: "lint", setDescription: "Lints more" });
    if (!plan.ok) throw new Error(plan.error.message);
    await writeFile(file(), mine.replace(/ {4}- name: lint\n.*\n.*\n/, ""));
    expect(await applyUpdate(ctx, plan.value)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
  });

  it("validates a new source like add, except that a local path needn't exist yet", async () => {
    const team: CatalogRef = { id: "team", kind: "remote", repo: "https://github.com/o/cat.git", yamlPath: "library.yaml", branch: "main", protected: false };
    const { sb, h, ctx, update } = await setup({ mine }, [team]);
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": mine.replace("name: review", "name: shared-review") });
    await refreshCatalogs(sb.host, ctx.git, [team]);

    expect(await update({ name: "review", setSource: join(sb.root, "later/SKILL.md") })).toMatchObject({ ok: true, value: { changed: true } });
    expect(await update({ name: "shared-review", setSource: join(sb.root, "later/SKILL.md") })).toMatchObject({ ok: false, error: { code: "LOCAL_SOURCE_REFUSED" } });
    expect(await update({ name: "review", setSource: "~/.claude/skills/review/SKILL.md" })).toMatchObject({ ok: false, error: { code: "SOURCE_IN_INSTALL_DIR" } });
    expect(await update({ name: "review", setSource: "ftp://nope" })).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE" } });
  });

  it("refuses an empty request, mixed requires changes, a bad ref, and an ambiguous name", async () => {
    const { update } = await setup({ mine, other: mine });
    expect(await update({ name: "review", catalog: "mine" })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await update({ name: "review", catalog: "mine", setDescription: "", setSource: "" })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await update({ name: "review", catalog: "mine", setRequires: [], addRequires: ["skill:x"] })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await update({ name: "review", catalog: "mine", addRequires: ["nocolon"] })).toMatchObject({ ok: false, error: { code: "INVALID_REF" } });
    expect(await update({ name: "review", setDescription: "x" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_CATALOG", catalogs: ["mine", "other"] } });
  });
});
