import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { applyInstall } from "./apply.ts";
import { planInstall, type InstallCtx } from "./plan.ts";
import { applySync, planSync } from "./sync.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

type Item = { type: "skill" | "agent" | "prompt"; name: string; source: string; requires?: string[] };
const yaml = (items: Item[]) => {
  const section = (t: Item["type"]) =>
    items
      .filter((i) => i.type === t)
      .map((i) => `    - name: ${i.name}\n      description: ${i.name}\n      source: ${i.source}\n${i.requires ? `      requires: [${i.requires.join(", ")}]\n` : ""}`)
      .join("");
  return `library:\n  skills:\n${section("skill")}  agents:\n${section("agent")}  prompts:\n${section("prompt")}`;
};
const gh = (path: string) => `https://github.com/o/r/blob/main/${path}`;

async function setup(catalogs: Record<string, Item[]>) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const config = createConfigStore(sb.host);
  const refs = [];
  for (const [id, items] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, yaml(items));
    refs.push({ id, kind: "local" as const, path });
  }
  await config.saveConfig({ version: 1, catalogs: refs, pins: {}, settings: {} });
  const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };
  const install = async (...names: string[]) => {
    const p = await planInstall(ctx, { names });
    if (!p.ok) throw new Error(p.error.message);
    await applyInstall(ctx, p.value);
  };
  const sync = async (req: { catalog?: string; force?: boolean } = {}) => {
    const p = await planSync(ctx, req);
    if (!p.ok) throw new Error(p.error.message);
    const r = await applySync(ctx, p.value);
    if (!r.ok) throw new Error(r.error.message);
    return { plan: p.value, report: r.value };
  };
  const setCatalog = (id: string, items: Item[]) => put(join(sb.root, `${id}.yaml`), yaml(items));
  return { sb, h, ctx, install, sync, setCatalog, home: sb.host.paths.home };
}

describe("sync", () => {
  it("SYNC-05: with nothing installed, reports nothing", async () => {
    const { sync } = await setup({ team: [{ type: "prompt", name: "p", source: gh("prompts/p.md") }] });
    expect((await sync()).report).toEqual({ synced: [], upToDate: [], failed: [], dependencies: [], unmanaged: [], missing: [] });
  });

  it("SYNC-01: refreshes the winning copy of each installed name, and only installed ones", async () => {
    const { h, install, sync, home } = await setup({
      team: [
        { type: "prompt", name: "p", source: gh("prompts/p.md") },
        { type: "prompt", name: "never", source: gh("prompts/never.md") },
      ],
    });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "prompts/p.md": "1\n", "prompts/never.md": "n\n" });
    await install("p");
    remote.commit({ "prompts/p.md": "2\n" });

    const { report } = await sync();
    expect(report.synced).toEqual([{ type: "prompt", name: "p", catalog: "team", dest: destFor(home, "prompt", "p"), preview: expect.objectContaining({ modified: ["p.md"] }) }]);
    expect(await readFile(destFor(home, "prompt", "p"), "utf8")).toBe("2\n");
    expect(await readFile(destFor(home, "prompt", "never"), "utf8").catch(() => "absent")).toBe("absent");
  });

  it("SYNC-02: skips unchanged items unless forced, and reports dependencies that weren't installed", async () => {
    const { h, install, sync, setCatalog } = await setup({
      team: [
        { type: "skill", name: "a", source: gh("skills/a/SKILL.md") },
        { type: "skill", name: "c", source: gh("skills/c/SKILL.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/c/SKILL.md": "c\n" });
    await install("a");
    // a now requires c, which was never installed.
    await setCatalog("team", [
      { type: "skill", name: "a", source: gh("skills/a/SKILL.md"), requires: ["skill:c"] },
      { type: "skill", name: "c", source: gh("skills/c/SKILL.md") },
    ]);

    const first = (await sync()).report;
    expect(first.upToDate).toEqual([{ type: "skill", name: "a", catalog: "team", status: "up-to-date" }]);
    expect(first.synced.map((s) => s.name)).toEqual(["c"]);
    expect(first.dependencies).toEqual([{ type: "skill", name: "c", catalog: "team", requiredBy: ["a"] }]);

    const second = (await sync()).report;
    expect(second.upToDate.map((u) => u.name)).toEqual(["c", "a"]);
    expect(second.synced).toEqual([]);

    const forced = (await sync({ force: true })).report;
    expect(forced.synced.map((s) => s.name)).toEqual(["c", "a"]);
    expect(forced.dependencies).toEqual([]);
  });

  it("SYNC-03 (A2): never overwrites unmanaged content; reports it instead", async () => {
    const { h, install, sync, setCatalog, home } = await setup({ team: [{ type: "prompt", name: "p", source: gh("prompts/p.md") }] });
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n", "prompts/dep.md": "d\n" });
    await install("p");
    await put(destFor(home, "prompt", "dep"), "hand-made\n");
    await setCatalog("team", [
      { type: "prompt", name: "p", source: gh("prompts/p.md"), requires: ["prompt:dep"] },
      { type: "prompt", name: "dep", source: gh("prompts/dep.md") },
    ]);

    const { report } = await sync({ force: true });
    expect(report.unmanaged).toEqual([{ type: "prompt", name: "dep", catalog: "team", dest: destFor(home, "prompt", "dep"), origin: "foreign" }]);
    expect(report.synced.map((s) => s.name)).toEqual(["p"]);
    expect(await readFile(destFor(home, "prompt", "dep"), "utf8")).toBe("hand-made\n");
  });

  it("SYNC-04: a failing item is reported and the run goes on", async () => {
    const { h, install, sync, setCatalog } = await setup({
      team: [
        { type: "prompt", name: "a", source: gh("prompts/a.md") },
        { type: "prompt", name: "b", source: gh("prompts/b.md") },
      ],
    });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "prompts/a.md": "a\n", "prompts/b.md": "b\n" });
    await install("a", "b");
    await setCatalog("team", [
      { type: "prompt", name: "a", source: gh("prompts/moved.md") },
      { type: "prompt", name: "b", source: gh("prompts/b.md") },
    ]);
    remote.commit({ "prompts/b.md": "b2\n" });

    const { report } = await sync();
    expect(report.failed).toEqual([{ type: "prompt", name: "a", catalog: "team", reason: "referenced file missing in repo: prompts/moved.md" }]);
    expect(report.synced.map((s) => s.name)).toEqual(["b"]);
  });

  it("SYNC-06: reports receipts whose destination is gone, filtered by catalog, and never reinstalls them", async () => {
    const { sb, h, install, sync, home } = await setup({
      team: [{ type: "prompt", name: "p", source: gh("prompts/p.md") }],
      other: [{ type: "prompt", name: "q", source: gh("prompts/q.md") }],
    });
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n", "prompts/q.md": "q\n" });
    await install("p", "q");
    await sb.host.fs.remove(destFor(home, "prompt", "p"));
    await sb.host.fs.remove(destFor(home, "prompt", "q"));

    const all = (await sync()).report;
    expect(all.missing.map((r) => r.name)).toEqual(["p", "q"]);
    expect(all.synced).toEqual([]);
    expect((await sync({ catalog: "team" })).report.missing.map((r) => r.name)).toEqual(["p"]);
    expect(await sb.host.fs.exists(destFor(home, "prompt", "p"))).toBe(false);
  });

  it("SYNC-01 (rebuild): an off skill refreshes in place and stays off", async () => {
    const { h, install, sync, home } = await setup({ team: [{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }] });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "1\n" });
    await install("a");
    const settings = join(home, ".claude/settings.json");
    await put(settings, '{"skillOverrides":{"a":"off"}}');
    remote.commit({ "skills/a/SKILL.md": "2\n" });

    expect((await sync()).report.synced.map((s) => s.name)).toEqual(["a"]);
    expect(await readFile(join(destFor(home, "skill", "a"), "SKILL.md"), "utf8")).toBe("2\n");
    expect(await readFile(settings, "utf8")).toBe('{"skillOverrides":{"a":"off"}}');
  });
});
