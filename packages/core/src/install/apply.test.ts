import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore, type AppConfigV1 } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { Host } from "../host.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { applyInstall, type ApplyOpts } from "./apply.ts";
import { discardPlan, planInstall, type InstallCtx } from "./plan.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

type Item = { type: "skill" | "agent" | "prompt"; name: string; source: string };
const yaml = (items: Item[]) => {
  const section = (t: Item["type"]) =>
    items.filter((i) => i.type === t).map((i) => `    - name: ${i.name}\n      description: ${i.name}\n      source: ${i.source}\n`).join("");
  return `library:\n  skills:\n${section("skill")}  agents:\n${section("agent")}  prompts:\n${section("prompt")}`;
};
const gh = (path: string) => `https://github.com/o/r/blob/main/${path}`;

async function setup(items: Item[], wrap: (host: Host) => Host = (h) => h) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  const h = createGitHarness(sb);
  const config = createConfigStore(host);
  const catalogFile = join(sb.root, "team.yaml");
  await put(catalogFile, yaml(items));
  await config.saveConfig({ version: 1, catalogs: [{ id: "team", kind: "local", path: catalogFile }], pins: {}, settings: {} } satisfies AppConfigV1);
  const receipts = createReceiptStore(host);
  const ctx: InstallCtx = { host, git: createGitClient(host), config, receipts };
  const plan = async (...names: string[]) => {
    const r = await planInstall(ctx, { names });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const apply = async (p: Awaited<ReturnType<typeof plan>>, opts?: ApplyOpts) => applyInstall(ctx, p, opts);
  const receipt = async (dest: string) => {
    const r = await receipts.get(dest);
    return r.ok ? r.value : null;
  };
  return { sb, h, host, ctx, plan, apply, receipt, catalogFile, home: sb.host.paths.home };
}

describe("applyInstall", () => {
  it("INST-04: installs each item and writes its receipt", async () => {
    const { sb, h, plan, apply, receipt, catalogFile, home } = await setup([
      { type: "skill", name: "a", source: gh("skills/a/SKILL.md") },
      { type: "prompt", name: "p", source: gh("prompts/p-v2.md") },
    ]);
    const remote = h.createRepo("github.com", "o/r");
    const tip = remote.commit({ "skills/a/SKILL.md": "a\n", "skills/a/ref/x.md": "x\n", "prompts/p-v2.md": "p\n" });
    const planned = await plan("a", "p");

    expect(await apply(planned)).toEqual({
      ok: true,
      value: {
        installed: [
          { type: "skill", name: "a", dest: destFor(home, "skill", "a"), preview: expect.objectContaining({ newInstall: true }) },
          { type: "prompt", name: "p", dest: destFor(home, "prompt", "p"), preview: expect.objectContaining({ newInstall: true }) },
        ],
        stopped: null,
        aborted: false,
      },
      warnings: [],
    });
    expect(await readFile(join(destFor(home, "skill", "a"), "ref/x.md"), "utf8")).toBe("x\n");
    expect(await readFile(destFor(home, "prompt", "p"), "utf8")).toBe("p\n");
    expect(await receipt(destFor(home, "skill", "a"))).toEqual({
      dest: destFor(home, "skill", "a"),
      type: "skill",
      name: "a",
      catalog: { id: "team", key: await realpath(catalogFile) },
      source: gh("skills/a/SKILL.md"),
      commit: tip,
      sourceOid: h.git(["rev-parse", `${tip}:skills/a`], { cwd: remote.path }),
      files: planned.items[0]!.fetched!.files,
      installedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
    expect(await sb.host.fs.exists(planned.opDir)).toBe(false);
  });

  it("INST-02: replacing a managed skill drops files only the old copy had, and reports progress", async () => {
    const { h, plan, apply, home } = await setup([{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }]);
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n", "skills/a/old.md": "o\n" });
    await apply(await plan("a"));
    remote.commit({ "skills/a/SKILL.md": "a2\n", "skills/a/old.md": null });

    const progress: unknown[] = [];
    await apply(await plan("a"), { onProgress: (p) => progress.push(p) });
    const dest = destFor(home, "skill", "a");
    expect((await readdir(dest)).sort()).toEqual(["SKILL.md"]);
    expect(await readdir(dirname(dest))).toEqual(["a"]);
    expect(progress).toEqual([{ done: 1, total: 1, item: { type: "skill", name: "a", dest } }]);
  });

  it("INST-06 (rebuild): an off skill updates in place and stays off", async () => {
    const { h, plan, apply, home } = await setup([{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }]);
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n" });
    await apply(await plan("a"));
    const settings = join(home, ".claude/settings.json");
    await put(settings, '{\n  "skillOverrides": { "a": "off" }\n}\n');
    remote.commit({ "skills/a/SKILL.md": "a2\n" });

    expect(await apply(await plan("a"))).toMatchObject({ ok: true, value: { installed: [{ name: "a" }] } });
    expect(await readFile(join(destFor(home, "skill", "a"), "SKILL.md"), "utf8")).toBe("a2\n");
    expect(await readFile(settings, "utf8")).toBe('{\n  "skillOverrides": { "a": "off" }\n}\n');
  });

  it("INST-07: stops at the first failing item, keeping earlier items and touching no later ones", async () => {
    const { h, plan, apply, receipt, home } = await setup([
      { type: "prompt", name: "first", source: gh("prompts/first.md") },
      { type: "prompt", name: "broken", source: gh("prompts/missing.md") },
      { type: "prompt", name: "last", source: gh("prompts/last.md") },
    ]);
    h.createRepo("github.com", "o/r").commit({ "prompts/first.md": "1\n", "prompts/last.md": "3\n" });
    const res = await apply(await plan("first", "broken", "last"));
    expect(res).toMatchObject({
      ok: true,
      value: { installed: [{ name: "first" }], stopped: { name: "broken", reason: "referenced file missing in repo: prompts/missing.md" } },
    });
    expect(await receipt(destFor(home, "prompt", "first"))).not.toBeNull();
    expect(await receipt(destFor(home, "prompt", "last"))).toBeNull();
    expect(await readdir(join(home, ".claude/commands"))).toEqual(["first.md"]);
  });

  it("returns STALE_PLAN when a destination changed after planning, before touching anything", async () => {
    const { h, plan, apply, home } = await setup([
      { type: "prompt", name: "p", source: gh("prompts/p.md") },
      { type: "prompt", name: "q", source: gh("prompts/q.md") },
    ]);
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n", "prompts/q.md": "q\n" });
    const planned = await plan("p", "q");
    await put(destFor(home, "prompt", "q"), "written meanwhile\n");
    expect(await apply(planned)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    expect(await readdir(join(home, ".claude/commands"))).toEqual(["q.md"]);
  });

  it("returns STALE_PLAN for a discarded plan", async () => {
    const { sb, h, plan, apply } = await setup([{ type: "prompt", name: "p", source: gh("prompts/p.md") }]);
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n" });
    const planned = await plan("p");
    await discardPlan(sb.host, planned);
    expect(await apply(planned)).toMatchObject({ ok: false, error: { code: "STALE_PLAN", message: expect.stringContaining("discarded") } });
  });

  it("Q8 A: replaces unmanaged content only when its exact path was consented to, then manages it", async () => {
    const { h, plan, apply, receipt, home } = await setup([{ type: "prompt", name: "p", source: gh("prompts/p.md") }]);
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "catalog\n" });
    const dest = destFor(home, "prompt", "p");
    await put(dest, "hand-made\n");

    expect(await apply(await plan("p"))).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await apply(await plan("p"), { overwrite: { unmanaged: [dest + "x"] } })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await readFile(dest, "utf8")).toBe("hand-made\n");

    expect(await apply(await plan("p"), { overwrite: { unmanaged: [dest] } })).toMatchObject({ ok: true, value: { installed: [{ name: "p" }] } });
    expect(await readFile(dest, "utf8")).toBe("catalog\n");
    expect(await receipt(dest)).toMatchObject({ name: "p" });
  });

  it("stops before the next item once aborted", async () => {
    const { h, plan, apply, home } = await setup([
      { type: "prompt", name: "p", source: gh("prompts/p.md") },
      { type: "prompt", name: "q", source: gh("prompts/q.md") },
    ]);
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n", "prompts/q.md": "q\n" });
    const ac = new AbortController();
    const res = await apply(await plan("p", "q"), { signal: ac.signal, onProgress: () => ac.abort() });
    expect(res).toMatchObject({ ok: true, value: { installed: [{ name: "p" }], stopped: null, aborted: true } });
    expect(await readdir(join(home, ".claude/commands"))).toEqual(["p.md"]);
  });
});

describe("applyInstall: interrupted moves", () => {
  it("R14: an install that fails moving the new copy in leaves the old copy and its receipt intact", async () => {
    let failIncoming = false;
    const { h, plan, apply, receipt, home } = await setup([{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }], (host) => ({
      ...host,
      fs: {
        ...host.fs,
        rename: (from, to) => (failIncoming && from.includes("/stage-") ? Promise.reject(new Error("disk full")) : host.fs.rename(from, to)),
      },
    }));
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "old\n" });
    await apply(await plan("a"));
    const dest = destFor(home, "skill", "a");
    const before = await receipt(dest);

    remote.commit({ "skills/a/SKILL.md": "new\n" });
    failIncoming = true;
    expect(await apply(await plan("a"))).toMatchObject({ ok: true, value: { installed: [], stopped: { name: "a", reason: "disk full" } } });
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("old\n");
    expect(await readdir(dirname(dest))).toEqual(["a"]);
    expect(await receipt(dest)).toEqual(before);
  });

  it("R14: across volumes, copies beside the destination and renames from there", async () => {
    const { sb, h, plan, apply, home } = await setup([{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }], (host) => ({
      ...host,
      fs: {
        ...host.fs,
        rename: (from, to) =>
          from.includes("/stage-") ? Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" })) : host.fs.rename(from, to),
      },
    }));
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/a/d/e.md": "e\n" });
    expect(await apply(await plan("a"))).toMatchObject({ ok: true, value: { installed: [{ name: "a" }] } });
    const dest = destFor(home, "skill", "a");
    expect(await readFile(join(dest, "d/e.md"), "utf8")).toBe("e\n");
    expect(await readdir(dirname(dest))).toEqual(["a"]);
    expect(sb.audit).toContainEqual(expect.objectContaining({ kind: "fs", op: "move", to: dest }));
  });
});
