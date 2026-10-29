import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { refreshCatalogs } from "../catalogs/catalogs.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef } from "../model/model.ts";
import { applyAdd, planAdd, type AddRequest } from "./add.ts";
import type { WriteCtx } from "./write.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const yaml = (...entries: [string, string][]) =>
  "library:\n  skills:\n" + entries.map(([n, s]) => `    - name: ${n}\n      description: d\n      source: ${s}\n`).join("") + "  agents: []\n  prompts: []\n";
const gh = (path: string) => `https://github.com/o/s/blob/main/${path}`;

async function setup(catalogs: Record<string, string> = { mine: yaml() }, remotes: CatalogRef[] = [], pins: Record<string, string> = {}) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const config = createConfigStore(sb.host);
  const refs: CatalogRef[] = [];
  for (const [id, text] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, text);
    refs.push({ id, kind: "local", path });
  }
  await config.saveConfig({ version: 1, catalogs: [...refs, ...remotes], pins, settings: {} });
  const ctx: WriteCtx = { host: sb.host, git: createGitClient(sb.host), config };
  const add = async (req: AddRequest) => {
    const plan = await planAdd(ctx, req);
    if (!plan.ok) return plan;
    const applied = await applyAdd(ctx, plan.value);
    return applied.ok ? { ...applied, warnings: [...plan.warnings, ...applied.warnings] } : applied;
  };
  const text = (id: string) => readFile(join(sb.root, `${id}.yaml`), "utf8");
  return { sb, h, ctx, add, text, home: sb.host.paths.home };
}

const one = (name: string, source: string, extra: Partial<AddRequest["entries"][number]> = {}) => ({ name, description: `About ${name}`, source, ...extra });

describe("add", () => {
  it("infers the type from the source and writes one entry", async () => {
    const { add, text } = await setup();
    const res = await add({ entries: [one("review", gh("skills/review/SKILL.md")), one("helper", gh("agents/helper/AGENT.md")), one("p", gh("prompts/p.md"))] });
    expect(res).toMatchObject({ ok: true, value: { mode: "local", added: [{ type: "skill", name: "review" }, { type: "agent", name: "helper" }, { type: "prompt", name: "p" }] } });
    const written = await text("mine");
    expect(written).toContain("  skills:\n    - name: review");
    expect(written).toContain("  agents:\n    - name: helper");
    expect(written).toContain("  prompts:\n    - name: p");
  });

  it("EDIT-13: a batch of three lands as one write", async () => {
    const { sb, add } = await setup();
    await add({ entries: [one("a", gh("a/SKILL.md")), one("b", gh("b/SKILL.md")), one("c", gh("c/SKILL.md"))] });
    expect(sb.audit.filter((e) => e.kind === "fs" && e.op === "write" && e.path.endsWith("mine.yaml"))).toHaveLength(1);
  });

  it("refuses duplicates in the batch and in the destination catalog, writing nothing", async () => {
    const { add, text } = await setup({ mine: yaml(["taken", gh("t/SKILL.md")]) });
    expect(await add({ entries: [one("x", gh("x/SKILL.md")), one("x", gh("y/SKILL.md"))] })).toMatchObject({ ok: false, error: { code: "DUPLICATE", message: "duplicate entry 'x' in batch" } });
    expect(await add({ entries: [one("taken", gh("prompts/taken.md"))] })).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE", message: "'taken' already in catalog (type skill); install it to refresh, or update it to change it" },
    });
    expect(await text("mine")).toBe(yaml(["taken", gh("t/SKILL.md")]));
  });

  it("DEP-11: refuses a malformed requires ref; DEP-10: warns about one not in the catalog yet", async () => {
    const { add } = await setup({ mine: yaml(["base", gh("base/SKILL.md")]) });
    expect(await add({ entries: [one("x", gh("x/SKILL.md"), { requires: ["widget:y"] })] })).toMatchObject({ ok: false, error: { code: "INVALID_REF" } });
    const res = await add({ entries: [one("x", gh("x/SKILL.md"), { requires: ["skill:base", "skill:y", "prompt:later"] }), one("later", gh("later.md"))] });
    expect(res.ok && res.warnings).toEqual([{ message: "required dependency skill:y (for x) is not in the catalog yet" }]);
  });

  it("warns which copy wins when the name exists in another catalog", async () => {
    const { add } = await setup({ mine: yaml(), team: yaml(["shared", gh("t/SKILL.md")]) }, [], {});
    const res = await add({ entries: [one("shared", gh("m/SKILL.md"))], catalog: "mine" });
    expect(res.ok && res.warnings).toEqual([{ message: "'shared' also exists in team; the copy in 'mine' takes precedence and will override it" }]);
    const pinned = await setup({ mine: yaml(), team: yaml(["shared", gh("t/SKILL.md")]) }, [], { shared: "team" });
    const res2 = await pinned.add({ entries: [one("shared", gh("m/SKILL.md"))], catalog: "mine" });
    expect(res2.ok && res2.warnings).toEqual([{ message: "'shared' also exists in team; 'team' is pinned for this name, so the copy in 'mine' will be overridden" }]);
  });

  it("refuses a folder source and a repo-root skill, explaining why (A9, Q13 d)", async () => {
    const { sb, h, add } = await setup();
    await put(join(sb.root, "work/skills/a/SKILL.md"));
    expect(await add({ entries: [one("a", join(sb.root, "work/skills/a"), { type: "skill" })] })).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE", message: expect.stringContaining("is a folder") } });
    const repo = join(sb.root, "rooted");
    await put(join(repo, "SKILL.md"));
    h.git(["init", "-q", repo]);
    expect(await add({ entries: [one("r", join(repo, "SKILL.md"))] })).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE", message: expect.stringContaining("root of a git repository") } });
    expect(await add({ entries: [one("r", "https://github.com/o/s/blob/main/SKILL.md")] })).toMatchObject({ ok: false, error: { message: expect.stringContaining("root of o/s") } });
  });

  it("refuses a missing local source and an unparseable one", async () => {
    const { sb, add } = await setup();
    expect(await add({ entries: [one("x", join(sb.root, "nope.md"))] })).toMatchObject({ ok: false, error: { code: "SOURCE_MISSING" } });
    expect(await add({ entries: [one("x", "ftp://x")] })).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE" } });
    expect(await add({ entries: [{ name: "x", description: "", source: gh("x.md") }] })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("WRITE-05: refuses a local path for a remote catalog, suggesting the file's URL; allows it on request", async () => {
    const team: CatalogRef = { id: "team", kind: "remote", repo: "https://github.com/o/cat.git", yamlPath: "library.yaml", branch: "main", protected: false };
    const { sb, h, ctx, add } = await setup({}, [team]);
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": yaml() });
    await refreshCatalogs(sb.host, ctx.git, [team]); // as the launch refresh does
    const work = join(sb.root, "work");
    await put(join(work, "prompts/p.md"));
    h.git(["init", "-q", "-b", "main", work]);
    h.git(["remote", "add", "origin", "git@github.com:o/lib.git"], { cwd: work });

    expect(await add({ entries: [one("p", join(work, "prompts/p.md"))] })).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_SOURCE_REFUSED",
        message:
          "local-path sources don't resolve for teammates pulling the shared catalog. Provide a GitHub/Bitbucket URL, or allow local paths for a personal catalog. " +
          "This file is in a git repo — did you mean: https://github.com/o/lib/blob/main/prompts/p.md",
      },
    });
    const allowed = await planAdd(ctx, { entries: [one("p", join(work, "prompts/p.md"))], allowLocal: true });
    expect(allowed).toMatchObject({ ok: true, value: { write: { mode: "direct" } } });
  });

  it("WRITE-06: refuses a source inside an install dir, even for a local catalog", async () => {
    const { add, home } = await setup();
    await put(join(home, ".claude/skills/a/SKILL.md"));
    expect(await add({ entries: [one("a", "~/.claude/skills/a/SKILL.md")] })).toMatchObject({
      ok: false,
      error: { code: "SOURCE_IN_INSTALL_DIR", message: expect.stringContaining("which is where skills install") },
    });
  });

  it("a dry run returns the diff and writes nothing", async () => {
    const { ctx, text } = await setup();
    const plan = await planAdd(ctx, { entries: [one("x", gh("x/SKILL.md"))], dryRun: true });
    if (!plan.ok) throw new Error(plan.error.message);
    const res = await applyAdd(ctx, plan.value);
    expect(res).toMatchObject({ ok: true, value: { diff: expect.stringContaining("+    - name: x") } });
    expect(await text("mine")).toBe(yaml());
  });
});
