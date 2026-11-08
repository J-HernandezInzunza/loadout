import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checked } from "../../test/checkedLibrary.ts";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { createConfigStore, type AppConfigV1 } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { applyInstall } from "../install/apply.ts";
import { planInstall, type InstallCtx } from "../install/plan.ts";
import { applySync, planSync } from "../install/sync.ts";
import type { CatalogRef } from "../model/model.ts";
import { createLibrary } from "../ops/library.ts";
import { ops } from "../ops/schemas.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import {
  applyDeleteLoadout,
  applySaveLoadout,
  launchCommand,
  listLoadouts,
  loadoutDir,
  planDeleteLoadout,
  planSaveLoadout,
  type LoadoutMember,
} from "./loadouts.ts";

type Skill = string | { name: string; requires?: string[]; source?: string };

const exists = (path: string) => access(path).then(() => true, () => false);
const listing = async (dir: string) => ((await exists(dir)) ? (await readdir(dir, { recursive: true })).sort() : []);

/** Local catalogs of skills; each source is `<root>/src/<catalog>/<name>/SKILL.md` holding "<catalog> <name>", unless given. */
async function setup(catalogs: Record<string, Skill[]>, pins: Record<string, string> = {}) {
  const sb = await createSandbox();
  const config = createConfigStore(sb.host);
  const refs: CatalogRef[] = [];
  for (const [id, skills] of Object.entries(catalogs)) {
    const blocks = [];
    for (const s of skills) {
      const { name, requires, source } = typeof s === "string" ? { name: s, requires: undefined, source: undefined } : s;
      const path = source ?? join(sb.root, "src", id, name, "SKILL.md");
      if (source === undefined) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${id} ${name}\n`);
      }
      const deps = requires ? `      requires: [${requires.map((r) => `"${r}"`).join(", ")}]\n` : "";
      blocks.push(`    - name: ${name}\n      description: D\n      source: ${path}\n${deps}`);
    }
    const file = join(sb.root, `${id}.yaml`);
    await writeFile(file, `library:\n  skills:\n${blocks.join("")}  agents: []\n  prompts: []\n`);
    refs.push({ id, kind: "local", path: file });
  }
  const initial: AppConfigV1 = { version: 1, catalogs: refs, pins, settings: {} };
  await config.saveConfig(initial);
  const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };
  const configFile = join(sb.host.paths.appData, "config.json");
  const onDisk = async () => JSON.parse(await readFile(configFile, "utf8")) as AppConfigV1;
  const save = async (name: string, members: LoadoutMember[], replace?: boolean) => {
    const plan = await planSaveLoadout(ctx, { name, members, ...(replace !== undefined && { replace }) });
    if (!plan.ok) throw new Error(plan.error.message);
    return applySaveLoadout(ctx, plan.value);
  };
  const folder = (name: string) => loadoutDir(sb.host.paths.appData, name);
  return { sb, ctx, initial, onDisk, save, folder };
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
      run: "loadout run review",
      command: expect.stringMatching(/^claude --add-dir='.*\/loadouts\/review'$/),
      members: [
        { ...skill("x"), resolvesTo: "a", state: "built" },
        { ...skill("y", "b"), resolvesTo: "b", state: "built" },
        { ...skill("z"), resolvesTo: "b", state: "built" },
      ],
    };
    expect(saved).toMatchObject({ ok: true, value: record, warnings: [] });
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

  it("keeps and reports members no catalog defines, and says they weren't built", async () => {
    const { ctx, onDisk } = await setup({ a: ["x"] });
    const unknown = [skill("nope"), skill("w", "gone"), { type: "prompt", name: "x" } as const];

    const plan = await planSaveLoadout(ctx, { name: "review", members: [skill("x"), ...unknown] });
    expect(plan).toMatchObject({ ok: true, value: { unknown } });
    if (!plan.ok) return;
    const saved = await applySaveLoadout(ctx, plan.value);

    const notDefined = (m: LoadoutMember) => ({ type: m.type, name: m.name, requiredBy: [], reason: "no catalog defines it" });
    expect(saved).toMatchObject({
      ok: true,
      value: {
        members: [{ resolvesTo: "a" }, { resolvesTo: null }, { resolvesTo: null }, { resolvesTo: null }],
        build: { built: [{ name: "x" }], failed: unknown.map(notDefined) },
      },
    });
    expect((await onDisk()).loadouts?.review?.members).toHaveLength(4);
  });

  it("deletes the loadout's config entry and folder, and nothing of another loadout's", async () => {
    const { ctx, onDisk, save, folder } = await setup({ a: ["x"] });
    await save("review", [skill("x")]);
    await save("docs", [skill("x")]);

    const plan = await planDeleteLoadout(ctx, "review");
    expect(plan).toMatchObject({ ok: true, value: { name: "review", previous: { members: [skill("x")] } } });
    if (!plan.ok) return;
    expect(await applyDeleteLoadout(ctx, plan.value)).toEqual({ ok: true, value: { name: "review", removedFolder: true }, warnings: [] });

    expect((await onDisk()).loadouts).toEqual({ docs: { members: [skill("x")] } });
    expect(await exists(folder("review"))).toBe(false);
    expect((await stat(join(folder("docs"), ".claude", "skills", "x"))).isDirectory()).toBe(true);
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
    const { ctx, initial, onDisk } = await setup({ a: ["x"] });
    expect(await listLoadouts(ctx)).toEqual({ ok: true, value: [], warnings: [] });
    const created = await planSaveLoadout(ctx, { name: "review", members: [] });
    if (!created.ok) throw new Error(created.error.message);
    await applySaveLoadout(ctx, created.value);
    const plan = await planDeleteLoadout(ctx, "review");
    if (!plan.ok) throw new Error(plan.error.message);
    expect(await applyDeleteLoadout(ctx, plan.value)).toMatchObject({ ok: true });
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
    expect(ops.applySaveLoadout.output.parse(value(await library.applySaveLoadout(save)))).toMatchObject({ name: "review", build: { built: [{ name: "x" }] } });
    expect(ops.loadouts.output.parse(value(await library.loadouts()))).toHaveLength(1);
    expect(ops.launchCommand.output.parse(value(await library.launchCommand("review")))).toMatchObject({ run: "loadout run review" });
    const remove = value(await library.planDeleteLoadout("review"));
    expect(ops.planDeleteLoadout.output.safeParse(remove).success).toBe(true);
    expect(ops.applyDeleteLoadout.output.parse(value(await library.applyDeleteLoadout(remove)))).toEqual({ name: "review", removedFolder: true });
    expect(await library.launchCommand("review")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("building a loadout's folder", () => {
  it("installs members and their requires under the loadout's folder only, with its own receipts", async () => {
    const { sb, save, folder } = await setup({ a: [{ name: "x", requires: ["skill:y"] }, "y", "z"] });
    const dir = folder("review");

    const saved = await save("review", [skill("x")]);

    expect(saved).toMatchObject({
      ok: true,
      value: {
        build: {
          built: [
            { type: "skill", name: "y", dest: `${dir}/.claude/skills/y`, requiredBy: ["x"] },
            { type: "skill", name: "x", dest: `${dir}/.claude/skills/x`, requiredBy: [] },
          ],
          failed: [],
          removed: [],
        },
      },
    });
    expect(await readFile(`${dir}/.claude/skills/x/SKILL.md`, "utf8")).toBe("a x\n");
    expect(await exists(join(sb.host.paths.home, ".claude"))).toBe(false);
    expect(await exists(join(sb.host.paths.appData, "receipts.json"))).toBe(false);
    const receipts = JSON.parse(await readFile(`${dir}/receipts.json`, "utf8")) as { installs: { dest: string }[] };
    expect(receipts.installs.map((r) => r.dest)).toEqual([`${dir}/.claude/skills/x`, `${dir}/.claude/skills/y`]);
  });

  it("removes what left the loadout, and touches neither another loadout's folder nor the global installs", async () => {
    const { sb, ctx, save, folder } = await setup({ a: ["x", "z"] });
    const global = await planInstall(ctx, { names: ["x"] });
    if (!global.ok) throw new Error(global.error.message);
    await applyInstall(ctx, global.value);
    await save("docs", [skill("x")]);
    await save("review", [skill("x"), skill("z")]);
    const home = join(sb.host.paths.home, ".claude");
    const others = async () => [await listing(home), await listing(folder("docs")), await readFile(join(sb.host.paths.appData, "receipts.json"), "utf8")];
    const before = await others();

    const replaced = await save("review", [skill("z")], true);

    const dir = folder("review");
    expect(replaced).toMatchObject({
      ok: true,
      value: { build: { built: [{ name: "z" }], failed: [], removed: [{ type: "skill", name: "x", dest: `${dir}/.claude/skills/x` }] } },
    });
    expect(await listing(`${dir}/.claude/skills`)).toEqual(["z", join("z", "SKILL.md")]);
    expect(await others()).toEqual(before);
    expect(before[2]).not.toContain(dir);
  });

  it("reports a member that can't be fetched, builds the rest, and keeps the member's earlier copy", async () => {
    const { sb, onDisk, save, folder } = await setup({ a: ["x", "y"] });
    await save("review", [skill("x"), skill("y")]);
    await rm(join(sb.root, "src", "a", "x"), { recursive: true });
    await writeFile(join(sb.root, "src", "a", "y", "SKILL.md"), "a y, changed\n");

    const rebuilt = await save("review", [skill("x"), skill("y")], true);

    const dir = folder("review");
    expect(rebuilt).toMatchObject({
      ok: true,
      value: { build: { built: [{ name: "y" }], failed: [{ type: "skill", name: "x", requiredBy: [], reason: expect.any(String) }], removed: [] } },
    });
    expect(await readFile(`${dir}/.claude/skills/x/SKILL.md`, "utf8")).toBe("a x\n");
    expect(await readFile(`${dir}/.claude/skills/y/SKILL.md`, "utf8")).toBe("a y, changed\n");
    expect((await onDisk()).loadouts).toEqual({ review: { members: [skill("x"), skill("y")] } });
  });

  it("replaces what its folder holds without a receipt, since only Loadout writes there", async () => {
    const { save, folder } = await setup({ a: ["x"] });
    const stray = `${folder("review")}/.claude/skills/x/stray.md`;
    await mkdir(dirname(stray), { recursive: true });
    await writeFile(stray, "stray\n");

    expect(await save("review", [skill("x")])).toMatchObject({ ok: true, value: { build: { built: [{ name: "x" }], failed: [] } } });
    expect(await exists(stray)).toBe(false);
  });

  it("FETCH-08: checks a local source against the loadout's destination, so a global install can be a member's source", async () => {
    const sb = await createSandbox();
    const source = join(sb.host.paths.home, ".claude", "skills", "x", "SKILL.md");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "installed x\n");
    const catalog = join(sb.root, "a.yaml");
    await writeFile(catalog, `library:\n  skills:\n    - name: x\n      description: D\n      source: ${source}\n  agents: []\n  prompts: []\n`);
    const config = createConfigStore(sb.host);
    await config.saveConfig({ version: 1, catalogs: [{ id: "a", kind: "local", path: catalog }], pins: {}, settings: {} });
    const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };

    const plan = await planSaveLoadout(ctx, { name: "review", members: [skill("x")] });
    if (!plan.ok) throw new Error(plan.error.message);
    expect(await applySaveLoadout(ctx, plan.value)).toMatchObject({ ok: true, value: { build: { built: [{ name: "x" }], failed: [] } } });
    expect(await planInstall(ctx, { names: ["x"] })).toMatchObject({ ok: true, value: { items: [{ status: "failed", reason: expect.stringContaining("the source is the destination") }] } });
  });
});

describe("keeping loadouts current", () => {
  const gh = (path: string) => `https://github.com/o/r/blob/main/${path}`;

  /** One catalog of skills sourced from a GitHub repo in the git harness. */
  async function setupRemote(skills: string[]) {
    const sb = await createSandbox();
    const remote = createGitHarness(sb).createRepo("github.com", "o/r");
    remote.commit(Object.fromEntries(skills.map((n) => [`skills/${n}/SKILL.md`, `${n} 1\n`])));
    const catalog = join(sb.root, "team.yaml");
    const block = (n: string) => `    - name: ${n}\n      description: D\n      source: ${gh(`skills/${n}/SKILL.md`)}\n`;
    await writeFile(catalog, `library:\n  skills:\n${skills.map(block).join("")}  agents: []\n  prompts: []\n`);
    const config = createConfigStore(sb.host);
    await config.saveConfig({ version: 1, catalogs: [{ id: "team", kind: "local", path: catalog }], pins: {}, settings: {} });
    const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };
    const save = async (name: string, members: LoadoutMember[], replace?: boolean) => {
      const plan = await planSaveLoadout(ctx, { name, members, ...(replace !== undefined && { replace }) });
      if (!plan.ok) throw new Error(plan.error.message);
      return applySaveLoadout(ctx, plan.value);
    };
    const states = async (checkRemote = false) => {
      const listed = await listLoadouts(ctx, { checkRemote });
      if (!listed.ok) throw new Error(listed.error.message);
      return Object.fromEntries(listed.value.map((l) => [l.name, Object.fromEntries(l.members.map((m) => [m.name, m.state]))]));
    };
    const sync = async (req: { catalog?: string } = {}) => {
      const plan = await planSync(ctx, req);
      if (!plan.ok) throw new Error(plan.error.message);
      const report = await applySync(ctx, plan.value);
      if (!report.ok) throw new Error(report.error.message);
      return { plan: plan.value, report: report.value };
    };
    return { sb, remote, ctx, save, states, sync, folder: (name: string) => loadoutDir(sb.host.paths.appData, name) };
  }

  it("a catalog change makes a member stale, Sync rebuilds it, and an unchanged member is skipped", async () => {
    const { sb, remote, save, states, sync, folder } = await setupRemote(["a", "b"]);
    await save("review", [skill("a"), skill("b")]);
    expect(await states(true)).toEqual({ review: { a: "built", b: "built" } });

    remote.commit({ "skills/a/SKILL.md": "a 2\n" });
    expect(await states()).toEqual({ review: { a: "built", b: "built" } });
    expect(await states(true)).toEqual({ review: { a: "stale", b: "built" } });
    expect((await sync({ catalog: "elsewhere" })).plan.loadouts).toEqual([]);

    const { plan, report } = await sync();
    expect(plan.loadouts).toMatchObject([{ name: "review", items: [{ name: "a" }], upToDate: [{ type: "skill", name: "b", catalog: "team", status: "unmoved" }] }]);
    expect(report.loadouts).toEqual([
      {
        name: "review",
        synced: [{ type: "skill", name: "a", catalog: "team", dest: `${folder("review")}/.claude/skills/a`, preview: expect.objectContaining({ modified: ["SKILL.md"] }) }],
        upToDate: [{ type: "skill", name: "b", catalog: "team", status: "unmoved" }],
        failed: [],
        removed: [],
      },
    ]);
    expect(report.synced).toEqual([]);
    expect(await readFile(`${folder("review")}/.claude/skills/a/SKILL.md`, "utf8")).toBe("a 2\n");
    expect(await exists(join(sb.host.paths.home, ".claude"))).toBe(false);
    expect(await states(true)).toEqual({ review: { a: "built", b: "built" } });
  });

  it("says what is missing, failed or edited, and Sync builds the missing member and restores the edited one", async () => {
    const { remote, save, states, sync, folder } = await setupRemote(["a", "b", "c"]);
    remote.commit({ "skills/c/SKILL.md": null });
    await save("review", [skill("a"), skill("c"), skill("nope")]);
    await writeFile(`${folder("review")}/.claude/skills/a/SKILL.md`, "edited\n");
    expect(await states()).toEqual({ review: { a: "stale", c: "missing", nope: "failed" } });

    remote.commit({ "skills/c/SKILL.md": "c 2\n" });
    const { report } = await sync();

    expect(report.loadouts).toMatchObject([{ name: "review", synced: [{ name: "a" }, { name: "c" }], failed: [] }]);
    expect(await readFile(`${folder("review")}/.claude/skills/a/SKILL.md`, "utf8")).toBe("a 1\n");
    expect(await readFile(`${folder("review")}/.claude/skills/c/SKILL.md`, "utf8")).toBe("c 2\n");
    expect(await states(true)).toEqual({ review: { a: "built", c: "built", nope: "failed" } });
  });
});

describe("launch command", () => {
  /** A config holding loadouts as given (nothing built), and what ~/.claude holds, under an app data path that needs quoting. */
  async function setupLaunch(loadouts: Record<string, LoadoutMember[]>, appDataName = "loadout") {
    const sb = await createSandbox();
    const appData = join(sb.root, "Application Support", appDataName);
    await mkdir(appData, { recursive: true });
    const host = { ...sb.host, paths: { ...sb.host.paths, appData } };
    const config = createConfigStore(host);
    const saved = Object.fromEntries(Object.entries(loadouts).map(([name, members]) => [name, { members }]));
    await config.saveConfig({ version: 1, catalogs: [], pins: {}, settings: {}, loadouts: saved });
    const ctx = { host, config, receipts: createReceiptStore(host), settings: createClaudeSettings(host) };
    const claude = join(sb.host.paths.home, ".claude");
    const put = async (rel: string, text = "x\n") => {
      await mkdir(dirname(join(claude, rel)), { recursive: true });
      await writeFile(join(claude, rel), text);
    };
    return { sb, ctx, appData, claude, put };
  }

  it("gives loadout run and the bare command, quoting a folder that holds a space and a single quote", async () => {
    const { ctx, appData } = await setupLaunch({ review: [] }, "it's here");
    const folder = `${appData}/loadouts/review`;

    const launch = await launchCommand(ctx, "review");

    expect(launch).toEqual({
      ok: true,
      value: { name: "review", run: "loadout run review", command: `claude --add-dir='${folder.replaceAll("'", "'\\''")}'`, clashes: [] },
      warnings: [],
    });
    if (!launch.ok) return;
    // The shell hands claude one argument holding the whole path.
    const argv = execFileSync("sh", ["-c", launch.value.command.replace(/^claude /, "printf '%s\\n' ")], { encoding: "utf8" });
    expect(argv).toBe(`--add-dir=${folder}\n`);
  });

  it("lists each member that shares a name with something Claude Code loads globally, and what the session makes of it", async () => {
    const members: LoadoutMember[] = [
      { type: "skill", name: "grilling" },
      { type: "skill", name: "review" },
      { type: "skill", name: "fleet" },
      { type: "prompt", name: "deploy" },
      { type: "prompt", name: "lint" },
      { type: "agent", name: "helper" },
      { type: "skill", name: "gone" },
      { type: "prompt", name: "team" },
      { type: "skill", name: "fresh" },
    ];
    const { ctx, claude, put } = await setupLaunch({ kit: members });
    await put("skills/grilling/SKILL.md");
    await put("skills/review/SKILL.md");
    await put("skills/lint/SKILL.md");
    await put("commands/fleet.md");
    await put("commands/deploy.md");
    await put("commands/team/standup.md");
    await put("agents/helper.md");
    await put("settings.json", JSON.stringify({ skillOverrides: { review: "off" } }));
    await mkdir(join(claude, "skills"), { recursive: true });
    await symlink(join(claude, "nowhere"), join(claude, "skills", "gone"));

    const launch = await launchCommand(ctx, "kit");

    expect(launch).toMatchObject({
      ok: true,
      value: {
        clashes: [
          { type: "skill", name: "grilling", with: "skill", outcome: "prefixed", sessionName: "kit:grilling" },
          { type: "skill", name: "review", with: "skill", outcome: "hidden", sessionName: null },
          { type: "skill", name: "fleet", with: "prompt", outcome: "shadows", sessionName: "fleet" },
          { type: "prompt", name: "deploy", with: "prompt", outcome: "prefixed", sessionName: "kit:deploy" },
          { type: "prompt", name: "lint", with: "skill", outcome: "prefixed", sessionName: "kit:lint" },
          { type: "agent", name: "helper", with: "agent", outcome: "unknown", sessionName: null },
        ],
      },
    });
  });

  it("refuses a loadout that doesn't exist, and a name that isn't a slug", async () => {
    const { ctx } = await setupLaunch({ review: [] });
    expect(await launchCommand(ctx, "docs")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await launchCommand(ctx, "My Kit", { members: [] })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("previews the clashes of members not saved yet, under the name they'd be saved as", async () => {
    const { ctx, put } = await setupLaunch({});
    await put("skills/grilling/SKILL.md");

    const preview = await launchCommand(ctx, "draft", { members: [{ type: "skill", name: "grilling" }] });

    expect(preview).toMatchObject({ ok: true, value: { run: "loadout run draft", clashes: [{ name: "grilling", outcome: "prefixed", sessionName: "draft:grilling" }] } });
  });
});

describe("a prompt that clashes gets the loadout's namespace", () => {
  /** One local catalog of prompts, each source `<root>/src/<name>.md` holding "<name> 1". */
  async function setupPrompts(prompts: string[]) {
    const sb = await createSandbox();
    const blocks = [];
    for (const name of prompts) {
      const source = join(sb.root, "src", `${name}.md`);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, `${name} 1\n`);
      blocks.push(`    - name: ${name}\n      description: D\n      source: ${source}\n`);
    }
    const catalog = join(sb.root, "team.yaml");
    await writeFile(catalog, `library:\n  skills: []\n  agents: []\n  prompts:\n${blocks.join("")}`);
    const config = createConfigStore(sb.host);
    await config.saveConfig({ version: 1, catalogs: [{ id: "team", kind: "local", path: catalog }], pins: {}, settings: {} });
    const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };
    const members = prompts.map((name) => ({ type: "prompt" as const, name }));
    const save = async () => {
      const plan = await planSaveLoadout(ctx, { name: "kit", members });
      if (!plan.ok) throw new Error(plan.error.message);
      return applySaveLoadout(ctx, plan.value);
    };
    const states = async () => {
      const listed = await listLoadouts(ctx);
      if (!listed.ok) throw new Error(listed.error.message);
      return Object.fromEntries(listed.value[0]!.members.map((m) => [m.name, m.state]));
    };
    const sync = async () => {
      const plan = await planSync(ctx);
      if (!plan.ok) throw new Error(plan.error.message);
      const report = await applySync(ctx, plan.value);
      if (!report.ok) throw new Error(report.error.message);
      return report.value;
    };
    const global = join(sb.host.paths.home, ".claude", "commands");
    const kit = join(loadoutDir(sb.host.paths.appData, "kit"), ".claude", "commands");
    const putGlobal = async (name: string) => {
      await mkdir(global, { recursive: true });
      await writeFile(join(global, `${name}.md`), "mine\n");
    };
    return { sb, save, states, sync, putGlobal, global, kit };
  }

  it("places a clashing prompt under the namespace when it builds, and the others bare", async () => {
    const { save, putGlobal, kit, states } = await setupPrompts(["standup", "grill-me"]);
    await putGlobal("grill-me");

    const saved = await save();

    expect(saved).toMatchObject({
      ok: true,
      value: { build: { built: [{ name: "standup", dest: join(kit, "standup.md") }, { name: "grill-me", dest: join(kit, "kit", "grill-me.md") }], failed: [] } },
    });
    expect(await listing(kit)).toEqual(["kit", join("kit", "grill-me.md"), "standup.md"]);
    expect(await states()).toEqual({ standup: "built", "grill-me": "built" });
  });

  it("goes stale when a clash comes or goes after the build, and Sync moves the prompt", async () => {
    const { save, putGlobal, global, kit, states, sync } = await setupPrompts(["standup"]);
    await save();
    await putGlobal("standup");
    expect(await states()).toEqual({ standup: "stale" });

    const moved = await sync();

    expect(moved.loadouts).toMatchObject([{ name: "kit", synced: [{ name: "standup", dest: join(kit, "kit", "standup.md") }], removed: [{ name: "standup", dest: join(kit, "standup.md") }], failed: [] }]);
    expect(await listing(kit)).toEqual(["kit", join("kit", "standup.md")]);
    expect(await states()).toEqual({ standup: "built" });

    await rm(join(global, "standup.md"));
    expect(await states()).toEqual({ standup: "stale" });
    await sync();
    expect(await listing(kit)).toEqual(["standup.md"]);
  });

  it("keeps the prompt where it was when the move can't fetch it", async () => {
    const { sb, save, putGlobal, kit, sync } = await setupPrompts(["standup"]);
    await save();
    await putGlobal("standup");
    await rm(join(sb.root, "src", "standup.md"));

    const report = await sync();

    expect(report.loadouts).toMatchObject([{ name: "kit", synced: [], removed: [], failed: [{ name: "standup" }] }]);
    expect(await readFile(join(kit, "standup.md"), "utf8")).toBe("standup 1\n");
  });
});

