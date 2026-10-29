import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { fileManifest } from "../receipts/hash.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { applyRemove, planRemove, type RemoveRequest } from "./remove.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const gh = (path: string) => `https://github.com/o/s/blob/main/${path}`;
const mine = `library:
  skills:
    - name: base
      description: Base
      source: ${gh("base/SKILL.md")}

    - name: uses-base
      description: Needs base
      source: ${gh("u/SKILL.md")}
      requires: ["skill:base"]
  agents: []
  prompts:
    - name: also
      description: Also needs base
      source: ${gh("also.md")}
      requires: ["skill:base", "prompt:x"]
`;

async function setup(catalogs: Record<string, string> = { mine }) {
  const sb = await createSandbox();
  const config = createConfigStore(sb.host);
  const refs = [];
  for (const [id, text] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, text);
    refs.push({ id, kind: "local" as const, path });
  }
  await config.saveConfig({ version: 1, catalogs: refs, pins: {}, settings: {} });
  const ctx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host), settings: createClaudeSettings(sb.host) };
  const remove = async (req: RemoveRequest) => {
    const plan = await planRemove(ctx, req);
    if (!plan.ok) return plan;
    const applied = await applyRemove(ctx, plan.value);
    return applied.ok ? { ...applied, warnings: [...plan.warnings, ...applied.warnings] } : applied;
  };
  const text = (id = "mine") => readFile(join(sb.root, `${id}.yaml`), "utf8");
  return { sb, ctx, remove, text, home: sb.host.paths.home };
}

describe("remove", () => {
  it("EDIT-10: removes the entry's block, with the blank line under it, through its catalog's write mode", async () => {
    const { remove, text } = await setup();
    const res = await remove({ name: "base" });
    expect(res).toMatchObject({ ok: true, value: { mode: "local", changed: true, removed: { type: "skill", name: "base" }, deleted: [] } });
    expect(await text()).toBe(mine.replace(/ {4}- name: base\n.*\n.*\n\n/, ""));
  });

  it("DEP-09: names the entries of the same catalog that require it", async () => {
    const { remove } = await setup({ mine, other: mine.replace(/base/g, "zzz") });
    const res = await remove({ name: "base", catalog: "mine" });
    expect(res).toMatchObject({ ok: true, value: { dependents: ["skill:uses-base", "prompt:also"] } });
    expect(res.warnings).toEqual([{ message: "removing a dependency of: skill:uses-base, prompt:also" }]);
    expect((await remove({ name: "also" })).warnings).toEqual([]);
  });

  it("refuses an unknown name and, when several catalogs hold it, asks which", async () => {
    const { remove } = await setup({ mine, other: mine });
    expect(await remove({ name: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await remove({ name: "base" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_CATALOG", catalogs: ["mine", "other"] } });
  });

  it("purge also uninstalls the installed copy, its receipt and override, after the write", async () => {
    const { sb, ctx, remove, home } = await setup();
    const dest = destFor(home, "skill", "base");
    await put(join(dest, "SKILL.md"));
    await ctx.receipts.put({ dest, type: "skill", name: "base", catalog: { id: "mine", key: "k" }, source: gh("base/SKILL.md"), commit: null, sourceOid: null, files: await fileManifest(sb.host, dest), installedAt: "2026-10-28T12:00:00Z" });
    await ctx.settings.editSkillOverrides({ base: "off" });

    expect(await remove({ name: "base", purge: true })).toMatchObject({ ok: true, value: { deleted: [dest] } });
    expect(await sb.host.fs.exists(dest)).toBe(false);
    expect(await ctx.receipts.get(dest)).toMatchObject({ value: null });
    expect(await ctx.settings.readSkillOverrides()).toMatchObject({ value: new Map() });
  });

  it("purge is forced: a copy Loadout didn't install goes too; a dry run purges nothing and writes nothing", async () => {
    const { sb, remove, text, home } = await setup();
    const dest = destFor(home, "prompt", "also");
    await put(dest);
    const dry = await remove({ name: "also", purge: true, dryRun: true });
    expect(dry).toMatchObject({ ok: true, value: { diff: expect.stringContaining("-    - name: also"), deleted: [] } });
    expect(await sb.host.fs.exists(dest)).toBe(true);
    expect(await text()).toBe(mine);

    expect(await remove({ name: "also", purge: true })).toMatchObject({ ok: true, value: { deleted: [dest] } });
    expect(await sb.host.fs.exists(dest)).toBe(false);
  });
});
