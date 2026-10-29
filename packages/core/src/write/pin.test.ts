import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { applyInstall } from "../install/apply.ts";
import { planInstall, type InstallCtx } from "../install/plan.ts";
import type { CatalogRef } from "../model/model.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { applyPin, planPin, unpin } from "./pin.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

type Skill = { name: string; requires?: string[] };

/** Local catalogs of skills, each skill with its own source folder under `<root>/src/<catalog>/<name>`. */
async function setup(catalogs: Record<string, Skill[]>) {
  const sb = await createSandbox();
  const config = createConfigStore(sb.host);
  const refs: CatalogRef[] = [];
  for (const [id, skills] of Object.entries(catalogs)) {
    const blocks = [];
    for (const s of skills) {
      const source = join(sb.root, "src", id, s.name, "SKILL.md");
      await put(source, `${id} ${s.name}\n`);
      const requires = s.requires ? `\n      requires: [${s.requires.map((r) => `"${r}"`).join(", ")}]` : "";
      blocks.push(`    - name: ${s.name}\n      description: D\n      source: ${source}${requires}\n`);
    }
    const path = join(sb.root, `${id}.yaml`);
    await put(path, `library:\n  skills:\n${blocks.join("\n")}  agents: []\n  prompts: []\n`);
    refs.push({ id, kind: "local", path });
  }
  await config.saveConfig({ version: 1, catalogs: refs, pins: {}, settings: {} });
  const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };
  const install = async (name: string, catalog?: string) => {
    const plan = await planInstall(ctx, { names: [name], ...(catalog && { catalog }) });
    if (!plan.ok) throw new Error(plan.error.message);
    const applied = await applyInstall(ctx, plan.value);
    if (!applied.ok || applied.value.stopped) throw new Error(JSON.stringify(applied));
  };
  const dest = (name: string) => destFor(sb.host.paths.home, "skill", name);
  const pins = async () => {
    const c = await config.loadConfig();
    return c.ok ? c.value.config.pins : null;
  };
  const installedFrom = async (name: string) => {
    const r = await ctx.receipts.get(dest(name));
    return r.ok ? (r.value?.catalog.id ?? null) : null;
  };
  return { sb, ctx, install, dest, pins, installedFrom };
}

describe("pin", () => {
  it("RES-13: refuses no catalog, an unknown catalog, an undefined name and a catalog without the name, writing nothing", async () => {
    const { ctx, pins } = await setup({ a: [{ name: "x" }], b: [{ name: "y" }] });
    expect(await planPin(ctx, { name: "x", catalog: "" })).toMatchObject({ ok: false, error: { message: "which catalog should 'x' resolve from?" } });
    expect(await planPin(ctx, { name: "x", catalog: "zz" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_CATALOG", message: "unknown catalog 'zz' (available: a, b)" } });
    expect(await planPin(ctx, { name: "nope", catalog: "a" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "no catalog defines 'nope'; nothing to pin" } });
    expect(await planPin(ctx, { name: "x", catalog: "b" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "'b' does not define 'x' (defined in: a)" } });
    expect(await pins()).toEqual({});
  });

  it("RES-14: a pin to the only holder is kept and reported as such", async () => {
    const { ctx, pins } = await setup({ a: [{ name: "x" }], b: [] });
    const plan = await planPin(ctx, { name: "x", catalog: "a" });
    expect(plan).toMatchObject({ ok: true, value: { holders: ["a"], onlyHolder: true, previous: null, switch: { switchable: false } } });
    const res = plan.ok ? await applyPin(ctx, plan.value, { switchInstalled: true }) : plan;
    expect(res).toMatchObject({ ok: true, value: { onlyHolder: true, installed: null } });
    expect(await pins()).toEqual({ x: "a" });
  });

  it("RES-15: assesses the installed copy, new dependencies and dependents before anything is written", async () => {
    const { ctx, install, dest, pins } = await setup({
      a: [{ name: "x" }, { name: "z", requires: ["skill:x"] }],
      b: [{ name: "x", requires: ["skill:y"] }, { name: "y" }],
    });
    await install("z");
    const plan = await planPin(ctx, { name: "x", catalog: "b" });
    expect(plan).toEqual({
      ok: true,
      value: {
        name: "x",
        catalog: "b",
        previous: null,
        holders: ["a", "b"],
        onlyHolder: false,
        switch: {
          switchable: true,
          simple: true,
          stale: [{ dest: dest("x"), state: "installed", from: "a" }],
          blockers: [],
          unresolvedRequires: [],
          newDependencies: ["y"],
          dependents: [{ name: "z", catalog: "a", direct: true }],
        },
      },
      warnings: [],
    });
    expect(await pins()).toEqual({});
  });

  it("RES-15: a drifted copy, an unmanaged copy and a require that doesn't resolve in the pinned catalog are blockers", async () => {
    const drifted = await setup({ a: [{ name: "x" }], b: [{ name: "x", requires: ["skill:missing"] }] });
    await drifted.install("x");
    await writeFile(join(drifted.dest("x"), "SKILL.md"), "edited\n");
    const plan = await planPin(drifted.ctx, { name: "x", catalog: "b" });
    expect(plan.ok && plan.value.switch).toMatchObject({
      switchable: true,
      simple: false,
      stale: [{ state: "drifted", from: "a" }],
      blockers: [
        `the copy at ${drifted.dest("x")} has edits Loadout didn't make; installing over it discards them`,
        "the 'b' copy requires skill:missing, which doesn't resolve in 'b'",
      ],
      unresolvedRequires: [{ ref: "skill:missing", requiredBy: "x" }],
    });

    const unmanaged = await setup({ a: [{ name: "x" }], b: [{ name: "x" }] });
    await put(join(unmanaged.dest("x"), "SKILL.md"), "by hand\n");
    const p2 = await planPin(unmanaged.ctx, { name: "x", catalog: "b" });
    expect(p2.ok && p2.value.switch).toMatchObject({
      stale: [{ state: "unmanaged", from: null }],
      blockers: [`the copy at ${unmanaged.dest("x")} wasn't installed by Loadout, so there is no record of what it is`],
    });
  });

  it("RES-15: nothing is stale when the pinned catalog's copy is the one installed", async () => {
    const { ctx, install } = await setup({ a: [{ name: "x" }], b: [{ name: "x" }] });
    await install("x", "b");
    const plan = await planPin(ctx, { name: "x", catalog: "b" });
    expect(plan.ok && plan.value.switch).toMatchObject({ switchable: false, simple: false, stale: [] });
  });

  it("RES-16: switchInstalled installs the pinned copy when the switch is simple", async () => {
    const { ctx, install, dest, pins, installedFrom } = await setup({ a: [{ name: "x" }], b: [{ name: "x", requires: ["skill:y"] }, { name: "y" }] });
    await install("x");
    const plan = await planPin(ctx, { name: "x", catalog: "b" });
    const res = plan.ok ? await applyPin(ctx, plan.value, { switchInstalled: true }) : plan;
    expect(res.ok && res.value.installed?.installed.map((i) => i.name)).toEqual(["y", "x"]);
    expect(await pins()).toEqual({ x: "b" });
    expect(await installedFrom("x")).toBe("b");
    expect(await readFile(join(dest("x"), "SKILL.md"), "utf8")).toBe("b x\n");
    // Re-assessed after the install: the pinned copy is now the one installed.
    expect(res.ok && res.value.switch.stale).toEqual([]);
  });

  it("RES-16: blockers or switchInstalled false leave the copy alone; the pin still stands", async () => {
    const blocked = await setup({ a: [{ name: "x" }], b: [{ name: "x" }] });
    await blocked.install("x");
    await writeFile(join(blocked.dest("x"), "SKILL.md"), "edited\n");
    const p1 = await planPin(blocked.ctx, { name: "x", catalog: "b" });
    expect(p1.ok && (await applyPin(blocked.ctx, p1.value, { switchInstalled: true }))).toMatchObject({ ok: true, value: { installed: null } });
    expect(await readFile(join(blocked.dest("x"), "SKILL.md"), "utf8")).toBe("edited\n");
    expect(await blocked.pins()).toEqual({ x: "b" });

    const declined = await setup({ a: [{ name: "x" }], b: [{ name: "x" }] });
    await declined.install("x");
    const p2 = await planPin(declined.ctx, { name: "x", catalog: "b" });
    expect(p2.ok && (await applyPin(declined.ctx, p2.value, { switchInstalled: false }))).toMatchObject({ ok: true, value: { installed: null, switch: { simple: true } } });
    expect(await declined.installedFrom("x")).toBe("a");
  });

  it("STALE_PLAN when the pin changed between plan and apply", async () => {
    const { ctx, pins } = await setup({ a: [{ name: "x" }], b: [{ name: "x" }] });
    const plan = await planPin(ctx, { name: "x", catalog: "b" });
    await ctx.config.updateConfig((c) => ({ ...c, pins: { x: "a" } }));
    expect(plan.ok && (await applyPin(ctx, plan.value, { switchInstalled: false }))).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    expect(await pins()).toEqual({ x: "a" });
  });
});

describe("unpin", () => {
  it("RES-17: refuses a name that isn't pinned, naming the pins", async () => {
    const { ctx } = await setup({ a: [{ name: "x" }, { name: "w" }] });
    expect(await unpin(ctx, "x")).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "'x' is not pinned (pinned: none)" } });
    await ctx.config.updateConfig((c) => ({ ...c, pins: { w: "a", v: "a" } }));
    expect(await unpin(ctx, "x")).toMatchObject({ ok: false, error: { message: "'x' is not pinned (pinned: v, w)" } });
  });

  it("RES-17: drops the pin, reports the new resolution and leaves installed copies alone", async () => {
    const { ctx, install, pins, installedFrom } = await setup({ a: [{ name: "x" }], b: [{ name: "x" }] });
    await ctx.config.updateConfig((c) => ({ ...c, pins: { x: "b" } }));
    await install("x");
    expect(await installedFrom("x")).toBe("b");
    expect(await unpin(ctx, "x")).toEqual({ ok: true, value: { name: "x", was: "b", resolvesTo: "a" }, warnings: [] });
    expect(await pins()).toEqual({});
    expect(await installedFrom("x")).toBe("b");
  });
});
