import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { parseCatalog } from "../catalog/read.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { fileManifest } from "../receipts/hash.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { applyAddCatalog, initCatalog, planAddCatalog, removeCatalog, type AddCatalogRequest } from "./register.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const yaml = (...names: string[]) =>
  "library:\n  skills:\n" + names.map((n) => `    - name: ${n}\n      description: d\n      source: /s/${n}/SKILL.md\n`).join("");

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const config = createConfigStore(sb.host);
  const ctx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host), settings: createClaudeSettings(sb.host) };
  const add = async (req: AddCatalogRequest) => {
    const plan = await planAddCatalog(ctx, req);
    return plan.ok ? applyAddCatalog(ctx, plan.value) : plan;
  };
  const ids = async () => {
    const c = await config.loadConfig();
    return c.ok ? c.value.config.catalogs.map((x) => x.id) : [];
  };
  return { sb, h, ctx, config, add, ids, clone: (id: string) => join(sb.host.paths.appData, "clones", id) };
}

describe("registering catalogs", () => {
  it("adds a local catalog after reading it, first by default or last on request", async () => {
    const { sb, add, ids } = await setup();
    await put(join(sb.root, "a/library.yaml"), yaml("x"));
    await put(join(sb.root, "b.yaml"), yaml("y"));
    expect(await add({ kind: "local", id: "a", path: join(sb.root, "a") })).toMatchObject({ ok: true });
    expect(await add({ kind: "local", id: "b", path: join(sb.root, "b.yaml"), position: "last" })).toMatchObject({ ok: true });
    await put(join(sb.root, "c.yaml"), yaml());
    await add({ kind: "local", id: "c", path: join(sb.root, "c.yaml") });
    expect(await ids()).toEqual(["c", "a", "b"]);
  });

  it("refuses a duplicate id, a relative path, and a file that isn't a catalog, saving nothing", async () => {
    const { sb, add, ids } = await setup();
    await put(join(sb.root, "a.yaml"), yaml("x"));
    await put(join(sb.root, "notes.yaml"), "just: notes\n");
    await put(join(sb.root, "broken.yaml"), "library: [\n");
    await add({ kind: "local", id: "a", path: join(sb.root, "a.yaml") });

    expect(await add({ kind: "local", id: "a", path: join(sb.root, "a.yaml") })).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
    expect(await add({ kind: "local", id: "rel", path: "a.yaml" })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await add({ kind: "local", id: "n", path: join(sb.root, "notes.yaml") })).toMatchObject({ ok: false, error: { message: expect.stringContaining("no 'library:' mapping") } });
    expect(await add({ kind: "local", id: "b", path: join(sb.root, "broken.yaml") })).toMatchObject({ ok: false, error: { message: expect.stringContaining("doesn't parse") } });
    expect(await add({ kind: "local", id: "m", path: join(sb.root, "missing.yaml") })).toMatchObject({ ok: false, error: { message: expect.stringContaining("no catalog file") } });
    expect(await add({ kind: "local", id: "  ", path: join(sb.root, "a.yaml") })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await ids()).toEqual(["a"]);
  });

  it("RCAT-01, A21: clones a remote to clones/<id> to prove it, and stores protected explicitly", async () => {
    const { sb, h, add, clone } = await setup();
    h.createRepo("bitbucket.org", "ws/lib").commit({ "catalog/library.yaml": yaml("x") });
    expect(await add({ kind: "remote", id: "team", repo: "git@bitbucket.org:ws/lib.git", yamlPath: "catalog/library.yaml", protected: false })).toMatchObject({ ok: true });
    expect(await readFile(join(clone("team"), "catalog/library.yaml"), "utf8")).toBe(yaml("x"));
    const saved = JSON.parse(await readFile(join(sb.host.paths.appData, "config.json"), "utf8"));
    expect(saved.catalogs).toEqual([{ id: "team", kind: "remote", repo: "git@bitbucket.org:ws/lib.git", yamlPath: "catalog/library.yaml", branch: "main", protected: false }]);
  });

  it("removes a fresh clone when the remote isn't a usable catalog, and reports a clone failure", async () => {
    const { sb, h, add, ids, clone } = await setup();
    h.createRepo("github.com", "o/notcat").commit({ "README.md": "hi\n" });
    expect(await add({ kind: "remote", id: "bad", repo: "https://github.com/o/notcat.git", protected: true })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await sb.host.fs.exists(clone("bad"))).toBe(false);
    expect(await add({ kind: "remote", id: "gone", repo: "https://github.com/o/gone.git", protected: true })).toMatchObject({ ok: false, error: { code: "GIT_FAILED" } });
    expect(await add({ kind: "remote", id: "y", repo: "https://github.com/o/notcat.git", yamlPath: "../x.yaml", protected: true })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await ids()).toEqual([]);
  });

  it("A20: refuses to reuse a clone dir of another repo for a new catalog", async () => {
    const { sb, h, add } = await setup();
    h.createRepo("github.com", "o/old").commit({ "library.yaml": yaml("old") });
    h.createRepo("github.com", "o/new").commit({ "library.yaml": yaml("new") });
    await add({ kind: "remote", id: "team", repo: "https://github.com/o/old.git", protected: true });
    await sb.host.fs.writeTextAtomic(join(sb.host.paths.appData, "config.json"), JSON.stringify({ version: 1, catalogs: [], pins: {}, settings: {} }));
    expect(await add({ kind: "remote", id: "team", repo: "https://github.com/o/new.git", protected: true })).toMatchObject({
      ok: false,
      error: { code: "GIT_FAILED", message: expect.stringContaining("is a clone of https://github.com/o/old.git") },
    });
  });
});

describe("creating catalogs", () => {
  it("EDIT-15, A18: a path without .yaml gets a library.yaml with the scaffold, registered", async () => {
    const { sb, ctx, ids } = await setup();
    const res = await initCatalog(ctx, { path: join(sb.root, "new-cat"), id: "mine" });
    expect(res).toMatchObject({ ok: true, value: { created: join(sb.root, "new-cat/library.yaml") } });
    const text = await readFile(join(sb.root, "new-cat/library.yaml"), "utf8");
    expect(parseCatalog(text)).toEqual({ ok: true, data: { library: { skills: [], agents: [], prompts: [] } } });
    expect(await ids()).toEqual(["mine"]);
  });

  it("writes to a named .yaml file, refuses an existing one, and removes the scaffold when registering fails", async () => {
    const { sb, ctx, ids } = await setup();
    expect(await initCatalog(ctx, { path: join(sb.root, "x/team.yaml"), id: "team" })).toMatchObject({ ok: true, value: { created: join(sb.root, "x/team.yaml") } });
    expect(await initCatalog(ctx, { path: join(sb.root, "x/team.yaml"), id: "other" })).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
    expect(await initCatalog(ctx, { path: join(sb.root, "y.yaml"), id: "team" })).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
    expect(await sb.host.fs.exists(join(sb.root, "y.yaml"))).toBe(false);
    expect(await ids()).toEqual(["team"]);
  });
});

describe("unregistering catalogs", () => {
  async function twoCatalogs() {
    const s = await setup();
    await put(join(s.sb.root, "a.yaml"), yaml("x"));
    await put(join(s.sb.root, "b.yaml"), yaml("y"));
    await s.add({ kind: "local", id: "a", path: join(s.sb.root, "a.yaml") });
    await s.add({ kind: "local", id: "b", path: join(s.sb.root, "b.yaml") });
    return s;
  }

  it("refuses an unknown id and the only catalog", async () => {
    const { sb, ctx, add } = await setup();
    await put(join(sb.root, "a.yaml"), yaml("x"));
    await add({ kind: "local", id: "a", path: join(sb.root, "a.yaml") });
    expect(await removeCatalog(ctx, { id: "nope" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_CATALOG" } });
    expect(await removeCatalog(ctx, { id: "a" })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("A19: purges the catalog's global installs, their receipts and overrides, and nothing elsewhere", async () => {
    const { sb, ctx, ids } = await twoCatalogs();
    const home = sb.host.paths.home;
    const ours = destFor(home, "skill", "x");
    const theirs = destFor(home, "skill", "y");
    const elsewhere = join(sb.root, "project/.claude/skills/x");
    for (const d of [ours, theirs, elsewhere]) await put(join(d, "SKILL.md"));
    const receipt = async (dest: string, id: string, name: string) =>
      ctx.receipts.put({ dest, type: "skill", name, catalog: { id, key: "k" }, source: "/s", commit: null, sourceOid: null, files: await fileManifest(sb.host, dest), installedAt: "2026-10-28T12:00:00Z" });
    await receipt(ours, "a", "x");
    await receipt(theirs, "b", "y");
    await receipt(elsewhere, "a", "x");
    await ctx.settings.editSkillOverrides({ x: "off", y: "off" });

    const res = await removeCatalog(ctx, { id: "a", purgeInstalls: true });
    expect(res).toEqual({ ok: true, value: { purgedClone: false, purgedInstalls: [ours], clearedReceipts: 1 }, warnings: [] });
    expect(await ids()).toEqual(["b"]);
    expect(await sb.host.fs.exists(ours)).toBe(false);
    expect(await sb.host.fs.exists(theirs)).toBe(true);
    expect(await sb.host.fs.exists(elsewhere)).toBe(true);
    const left = await ctx.receipts.all();
    expect(left.ok && left.value.map((r) => r.dest).sort()).toEqual([elsewhere, theirs].sort());
    expect(await ctx.settings.readSkillOverrides()).toMatchObject({ value: new Map([["y", "off"]]) });
  });

  it("purges a remote catalog's clone on request, and keeps it otherwise", async () => {
    const { sb, h, ctx, add, clone } = await setup();
    await put(join(sb.root, "a.yaml"), yaml("x"));
    await add({ kind: "local", id: "a", path: join(sb.root, "a.yaml") });
    h.createRepo("github.com", "o/c").commit({ "library.yaml": yaml("r") });
    await add({ kind: "remote", id: "r1", repo: "https://github.com/o/c.git", protected: true });
    await add({ kind: "remote", id: "r2", repo: "https://github.com/o/c.git", protected: true });

    expect(await removeCatalog(ctx, { id: "r1" })).toMatchObject({ ok: true, value: { purgedClone: false } });
    expect(await sb.host.fs.exists(clone("r1"))).toBe(true);
    expect(await removeCatalog(ctx, { id: "r2", purgeClone: true })).toMatchObject({ ok: true, value: { purgedClone: true } });
    expect(await sb.host.fs.exists(clone("r2"))).toBe(false);
  });
});
