import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checked } from "../../test/checkedLibrary.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore, type AppConfigV1 } from "../config/config.ts";
import type { CatalogRef } from "../model/model.ts";
import { createLibrary } from "../ops/library.ts";
import { ops } from "../ops/schemas.ts";
import { applyDeleteLoadout, applySaveLoadout, listLoadouts, loadoutDir, planDeleteLoadout, planSaveLoadout, type LoadoutMember } from "./loadouts.ts";

/** Local catalogs of skills; the registry reads only the catalog files, so sources needn't exist. */
async function setup(catalogs: Record<string, string[]>, pins: Record<string, string> = {}) {
  const sb = await createSandbox();
  const config = createConfigStore(sb.host);
  const refs: CatalogRef[] = [];
  for (const [id, skills] of Object.entries(catalogs)) {
    const blocks = skills.map((name) => `    - name: ${name}\n      description: D\n      source: ${join(sb.root, "src", name)}\n`);
    const path = join(sb.root, `${id}.yaml`);
    await writeFile(path, `library:\n  skills:\n${blocks.join("")}  agents: []\n  prompts: []\n`);
    refs.push({ id, kind: "local", path });
  }
  const initial: AppConfigV1 = { version: 1, catalogs: refs, pins, settings: {} };
  await config.saveConfig(initial);
  const ctx = { host: sb.host, config };
  const configFile = join(sb.host.paths.appData, "config.json");
  const onDisk = async () => JSON.parse(await readFile(configFile, "utf8")) as AppConfigV1;
  const save = async (name: string, members: LoadoutMember[], replace?: boolean) => {
    const plan = await planSaveLoadout(ctx, { name, members, ...(replace !== undefined && { replace }) });
    if (!plan.ok) throw new Error(plan.error.message);
    return applySaveLoadout(ctx, plan.value);
  };
  return { sb, ctx, initial, onDisk, save };
}

const skill = (name: string, catalog?: string): LoadoutMember => ({ type: "skill", name, ...(catalog !== undefined && { catalog }) });

describe("loadouts", () => {
  it("creates a loadout and reports where each member resolves, by catalog order and pins", async () => {
    const { ctx, onDisk } = await setup({ a: ["x", "y", "z"], b: ["y", "z"] }, { z: "b" });
    const members = [skill("x"), skill("y", "b"), skill("z")];

    const plan = await planSaveLoadout(ctx, { name: "review", members });
    expect(plan).toMatchObject({ ok: true, value: { name: "review", members, previous: null, unknown: [] } });
    if (!plan.ok) return;
    const saved = await applySaveLoadout(ctx, plan.value);

    const record = {
      name: "review",
      members: [
        { ...skill("x"), resolvesTo: "a" },
        { ...skill("y", "b"), resolvesTo: "b" },
        { ...skill("z"), resolvesTo: "b" },
      ],
    };
    expect(saved).toEqual({ ok: true, value: record, warnings: [] });
    expect(await listLoadouts(ctx)).toEqual({ ok: true, value: [record], warnings: [] });
    expect((await onDisk()).loadouts).toEqual({ review: { members } });
  });

  it("refuses a new name that exists (DUPLICATE), and replaces it when asked", async () => {
    const { ctx, onDisk, save } = await setup({ a: ["x", "y"] });
    await save("review", [skill("x")]);

    expect(await planSaveLoadout(ctx, { name: "review", members: [skill("y")] })).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });

    const plan = await planSaveLoadout(ctx, { name: "review", members: [skill("y")], replace: true });
    expect(plan).toMatchObject({ ok: true, value: { previous: { members: [skill("x")] } } });
    if (!plan.ok) return;
    expect(await applySaveLoadout(ctx, plan.value)).toMatchObject({ ok: true, value: { members: [{ name: "y", resolvesTo: "a" }] } });
    expect((await onDisk()).loadouts).toEqual({ review: { members: [skill("y")] } });
  });

  it("saves members handed back from loadouts() without their resolution", async () => {
    const { ctx, onDisk, save } = await setup({ a: ["x", "y"] });
    await save("review", [skill("x", "a")]);
    const listed = await listLoadouts(ctx);
    if (!listed.ok) throw new Error(listed.error.message);

    const replaced = await save("review", [...listed.value[0]!.members, skill("y")], true);
    expect(replaced).toMatchObject({ ok: true });
    expect((await onDisk()).loadouts).toEqual({ review: { members: [skill("x", "a"), skill("y")] } });
  });

  it.each(["Review", "my loadout", "-review", "review-", "a--b", "../x", "x/y", "café", ""])("refuses the name %j, writing nothing", async (name) => {
    const { ctx, initial, onDisk } = await setup({ a: ["x"] });
    expect(await planSaveLoadout(ctx, { name, members: [skill("x")] })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await onDisk()).toEqual(initial);
  });

  it("refuses a member listed twice, and replacing a loadout that doesn't exist", async () => {
    const { ctx, initial, onDisk } = await setup({ a: ["x"], b: ["x"] });
    const twice = await planSaveLoadout(ctx, { name: "review", members: [skill("x"), skill("x", "b")] });
    expect(twice).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
    expect(await planSaveLoadout(ctx, { name: "review", members: [], replace: true })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await onDisk()).toEqual(initial);
  });

  it("keeps and reports members no catalog defines", async () => {
    const { ctx, onDisk } = await setup({ a: ["x"] });
    const unknown = [skill("nope"), skill("w", "gone"), { type: "prompt", name: "x" } as const];

    const plan = await planSaveLoadout(ctx, { name: "review", members: [skill("x"), ...unknown] });
    expect(plan).toMatchObject({ ok: true, value: { unknown } });
    if (!plan.ok) return;
    const saved = await applySaveLoadout(ctx, plan.value);

    expect(saved).toMatchObject({ ok: true, value: { members: [{ resolvesTo: "a" }, { resolvesTo: null }, { resolvesTo: null }, { resolvesTo: null }] } });
    expect((await onDisk()).loadouts?.review?.members).toHaveLength(4);
  });

  it("deletes the loadout's config entry and folder, and nothing of another loadout's", async () => {
    const { sb, ctx, onDisk, save } = await setup({ a: ["x"] });
    await save("review", [skill("x")]);
    await save("docs", [skill("x")]);
    for (const name of ["review", "docs"]) {
      await mkdir(join(loadoutDir(sb.host.paths.appData, name), ".claude", "skills", "x"), { recursive: true });
    }

    const plan = await planDeleteLoadout(ctx, "review");
    expect(plan).toMatchObject({ ok: true, value: { name: "review", previous: { members: [skill("x")] } } });
    if (!plan.ok) return;
    expect(await applyDeleteLoadout(ctx, plan.value)).toEqual({ ok: true, value: { name: "review", removedFolder: true }, warnings: [] });

    expect((await onDisk()).loadouts).toEqual({ docs: { members: [skill("x")] } });
    await expect(stat(loadoutDir(sb.host.paths.appData, "review"))).rejects.toThrow();
    expect((await stat(join(loadoutDir(sb.host.paths.appData, "docs"), ".claude", "skills", "x"))).isDirectory()).toBe(true);
    expect(await planDeleteLoadout(ctx, "review")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("refuses to apply a plan when the loadout changed after it was made (STALE_PLAN)", async () => {
    const { ctx, onDisk, save } = await setup({ a: ["x", "y"] });
    const create = await planSaveLoadout(ctx, { name: "review", members: [skill("x")] });
    await save("review", [skill("y")]);
    const remove = await planDeleteLoadout(ctx, "review");
    await save("review", [skill("x")], true);
    if (!create.ok || !remove.ok) throw new Error("planning failed");

    expect(await applySaveLoadout(ctx, create.value)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    expect(await applyDeleteLoadout(ctx, remove.value)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    expect((await onDisk()).loadouts).toEqual({ review: { members: [skill("x")] } });
  });

  it("reads a config without loadouts as none, and leaves it without them after the last one goes", async () => {
    const { ctx, initial, onDisk, save } = await setup({ a: ["x"] });
    expect(await listLoadouts(ctx)).toEqual({ ok: true, value: [], warnings: [] });
    await save("review", [skill("x")]);
    const plan = await planDeleteLoadout(ctx, "review");
    if (!plan.ok) throw new Error(plan.error.message);
    expect(await applyDeleteLoadout(ctx, plan.value)).toMatchObject({ ok: true, value: { removedFolder: false } });
    expect(await onDisk()).toEqual(initial);
  });

  it("serves each op through the facade in the shape its schema describes", async () => {
    const { sb } = await setup({ a: ["x"] });
    const library = checked(createLibrary(sb.host));
    const value = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => {
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };

    const save = value(await library.planSaveLoadout({ name: "review", members: [skill("x"), skill("nope")] }));
    expect(ops.planSaveLoadout.output.safeParse(save).success).toBe(true);
    expect(ops.applySaveLoadout.output.parse(value(await library.applySaveLoadout(save)))).toMatchObject({ name: "review" });
    expect(ops.loadouts.output.parse(value(await library.loadouts()))).toHaveLength(1);
    const remove = value(await library.planDeleteLoadout("review"));
    expect(ops.planDeleteLoadout.output.safeParse(remove).success).toBe(true);
    expect(ops.applyDeleteLoadout.output.parse(value(await library.applyDeleteLoadout(remove)))).toEqual({ name: "review", removedFolder: false });
  });
});
