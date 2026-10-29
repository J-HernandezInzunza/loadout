import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { createConfigStore } from "../config/config.ts";
import { fileManifest } from "../receipts/hash.ts";
import { createReceiptStore, type ReceiptV2 } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { uninstall, type UninstallCtx } from "./uninstall.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function setup(entries: { type: "skill" | "agent" | "prompt"; name: string }[] = []) {
  const sb = await createSandbox();
  const home = sb.host.paths.home;
  const config = createConfigStore(sb.host);
  const catalog = join(sb.root, "team.yaml");
  const section = (t: string) =>
    entries.filter((e) => e.type === t).map((e) => `    - name: ${e.name}\n      description: d\n      source: /src/${e.name}.md\n`).join("");
  await put(catalog, `library:\n  skills:\n${section("skill")}  agents:\n${section("agent")}  prompts:\n${section("prompt")}`);
  await config.saveConfig({ version: 1, catalogs: [{ id: "team", kind: "local", path: catalog }], pins: {}, settings: {} });
  const receipts = createReceiptStore(sb.host);
  const settings = createClaudeSettings(sb.host);
  const ctx: UninstallCtx = { host: sb.host, config, receipts, settings };
  /** Puts content at the destination and, when managed, a receipt for it. */
  const installed = async (type: ReceiptV2["type"], name: string, managed = true) => {
    const dest = destFor(home, type, name);
    if (type === "skill") await put(join(dest, "SKILL.md"));
    else await put(dest);
    if (managed) {
      await receipts.put({
        dest,
        type,
        name,
        catalog: { id: "team", key: "k" },
        source: `/src/${name}.md`,
        commit: null,
        sourceOid: null,
        files: await fileManifest(sb.host, dest),
        installedAt: "2026-10-28T12:00:00Z",
      });
    }
    return dest;
  };
  const receiptOf = async (dest: string) => {
    const r = await receipts.get(dest);
    return r.ok ? r.value : "unreadable";
  };
  return { sb, home, ctx, settings, installed, receiptOf };
}

describe("uninstall", () => {
  it("UNIN-02: deletes a managed install and its receipt", async () => {
    const { sb, ctx, installed, receiptOf } = await setup([{ type: "skill", name: "a" }]);
    const dest = await installed("skill", "a");
    expect(await uninstall(ctx, { names: ["a"] })).toEqual({
      ok: true,
      value: { items: [{ type: "skill", name: "a", dest, outcome: "deleted", overrideRemoved: null }] },
      warnings: [],
    });
    expect(await sb.host.fs.exists(dest)).toBe(false);
    expect(await receiptOf(dest)).toBeNull();
    expect(sb.audit).toContainEqual({ kind: "fs", op: "delete", path: dest });
  });

  it("UNIN-02: refuses unmanaged content unless its exact path is forced", async () => {
    const { sb, ctx, installed } = await setup([{ type: "prompt", name: "p" }]);
    const dest = await installed("prompt", "p", false);
    expect(await uninstall(ctx, { names: ["p"] })).toMatchObject({ ok: true, value: { items: [{ outcome: "refused" }] } });
    expect(await uninstall(ctx, { names: ["p"], forcePaths: [dest + ".bak"] })).toMatchObject({ value: { items: [{ outcome: "refused" }] } });
    expect(await sb.host.fs.exists(dest)).toBe(true);
    expect(await uninstall(ctx, { names: ["p"], forcePaths: [dest] })).toMatchObject({ value: { items: [{ outcome: "deleted" }] } });
    expect(await sb.host.fs.exists(dest)).toBe(false);
  });

  it("UNIN-02: prunes a receipt whose destination is already gone", async () => {
    const { sb, ctx, installed, receiptOf } = await setup([{ type: "agent", name: "g" }]);
    const dest = await installed("agent", "g");
    await sb.host.fs.remove(dest);
    expect(await uninstall(ctx, { names: ["g"] })).toMatchObject({ value: { items: [{ outcome: "pruned" }] } });
    expect(await receiptOf(dest)).toBeNull();
    expect(await uninstall(ctx, { names: ["g"] })).toMatchObject({ value: { items: [{ outcome: "absent" }] } });
  });

  it("UNIN-01: only the global destination is considered, never other paths a receipt mentions", async () => {
    const { sb, ctx, installed } = await setup([{ type: "prompt", name: "p" }]);
    const elsewhere = join(sb.root, "project/.claude/commands/p.md");
    await put(elsewhere);
    await installed("prompt", "p");
    await uninstall(ctx, { names: ["p"] });
    expect(await sb.host.fs.exists(elsewhere)).toBe(true);
  });

  it("Q17 A: removes the skill's or prompt's override and reports it, leaving agents and other names alone", async () => {
    const { ctx, settings, installed } = await setup([
      { type: "skill", name: "a" },
      { type: "prompt", name: "p" },
      { type: "skill", name: "keep" },
    ]);
    await installed("skill", "a");
    await installed("prompt", "p");
    await settings.editSkillOverrides({ a: "off", p: "name-only", keep: "off" });
    expect(await uninstall(ctx, { names: ["a", "p"] })).toMatchObject({
      ok: true,
      value: { items: [{ name: "a", overrideRemoved: "off" }, { name: "p", overrideRemoved: "name-only" }] },
    });
    expect(await settings.readSkillOverrides()).toMatchObject({ value: new Map([["keep", "off"]]) });
  });

  it("Q17 A: a settings file it can't edit is a warning; the uninstall still happened", async () => {
    const { sb, ctx, settings, installed } = await setup([{ type: "skill", name: "a" }]);
    const dest = await installed("skill", "a");
    await put(settings.file, "{ broken");
    const res = await uninstall(ctx, { names: ["a"] });
    expect(res).toMatchObject({ ok: true, value: { items: [{ outcome: "deleted", overrideRemoved: null }] } });
    expect(res.warnings[0]!.message).toMatch(/^uninstalled, but the skillOverrides entries were left: /);
    expect(await sb.host.fs.exists(dest)).toBe(false);
  });

  it("resolves every name first, and uninstalls an entry its catalog no longer lists", async () => {
    const { sb, home, ctx, installed } = await setup([{ type: "skill", name: "a" }]);
    const a = await installed("skill", "a");
    const dropped = await installed("prompt", "dropped-from-catalog");
    expect(await uninstall(ctx, { names: ["a", "nope"] })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", query: "nope" } });
    expect(await sb.host.fs.exists(a)).toBe(true);
    expect(await uninstall(ctx, { names: ["dropped-from-catalog"] })).toMatchObject({ value: { items: [{ type: "prompt", outcome: "deleted" }] } });
    expect(await sb.host.fs.exists(dropped)).toBe(false);
    expect(await readdir(join(home, ".claude/skills"))).toEqual(["a"]);
  });

  it("removes a forced symlink without touching what it points at", async () => {
    const { sb, home, ctx } = await setup();
    const target = join(sb.root, "tool");
    await put(join(target, "SKILL.md"));
    const link = destFor(home, "skill", "library");
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link);
    expect(await uninstall(ctx, { names: ["library"], forcePaths: [link] })).toMatchObject({ value: { items: [{ outcome: "deleted" }] } });
    expect(await sb.host.fs.exists(link)).toBe(false);
    expect(await readdir(target)).toEqual(["SKILL.md"]);
  });
});
