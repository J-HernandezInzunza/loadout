import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CoreError, Result } from "../model/model.ts";
import { destFor } from "../scan/scan.ts";
import { createLibrary } from "./library.ts";
import { ops } from "./schemas.ts";

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

const items: Item[] = [
  { type: "skill", name: "tidy", source: gh("skills/tidy/SKILL.md") },
  { type: "prompt", name: "style", source: gh("prompts/style.md") },
  { type: "agent", name: "helper", source: gh("agents/helper.md") },
];

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const repo = h.createRepo("github.com", "o/r");
  repo.commit({ "skills/tidy/SKILL.md": "tidy\n", "prompts/style.md": "style\n", "agents/helper.md": "helper\n" });
  const catalog = join(sb.root, "team.yaml");
  await put(catalog, yaml(items));
  await createConfigStore(sb.host).saveConfig({ version: 1, catalogs: [{ id: "team", kind: "local", path: catalog }], pins: {}, settings: {} });
  const library = createLibrary(sb.host, { git: createGitClient(sb.host) });
  const home = sb.host.paths.home;
  return { sb, repo, library, home, settingsFile: join(home, ".claude/settings.json") };
}

/** The op's value, checked against the op's output schema. */
function value<T, E extends CoreError>(r: Result<T, E>, schema: { safeParse(v: unknown): { success: boolean } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expect(schema.safeParse(r.value).success).toBe(true);
  return r.value;
}

async function installed(library: ReturnType<typeof createLibrary>, ...names: string[]) {
  const plan = value(await library.planInstall({ names }), ops.planInstall.output);
  return value(await library.applyInstall(plan), ops.applyInstall.output);
}

describe("facade: install lifecycle", () => {
  it("planInstall previews each item with its dependencies; an unknown name is NOT_FOUND with candidates", async () => {
    const { library, home } = await setup();
    const plan = value(await library.planInstall({ names: ["tidy", "style"] }), ops.planInstall.output);
    expect(plan.items.map((i) => [i.name, i.dest, i.status, i.preview.kind])).toEqual([
      ["tidy", destFor(home, "skill", "tidy"), "ready", "files"],
      ["style", destFor(home, "prompt", "style"), "ready", "files"],
    ]);
    expect(await library.discardPlan(plan)).toMatchObject({ ok: true });

    const missing = await library.planInstall({ names: ["style", "nothing"] });
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND", candidates: [] } });
  });

  it("applyInstall installs the plan; unmanaged content without consent is REFUSED", async () => {
    const { library, home } = await setup();
    const report = await installed(library, "style");
    expect(report).toMatchObject({ installed: [{ name: "style" }], stopped: null, aborted: false });
    expect(await readFile(destFor(home, "prompt", "style"), "utf8")).toBe("style\n");

    await put(destFor(home, "skill", "tidy") + "/SKILL.md", "mine\n");
    const plan = value(await library.planInstall({ names: ["tidy"] }), ops.planInstall.output);
    expect(await library.applyInstall(plan)).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    const consented = await library.applyInstall(plan, { overwrite: { unmanaged: [destFor(home, "skill", "tidy")] } });
    expect(value(consented, ops.applyInstall.output).installed.map((i) => i.name)).toEqual(["tidy"]);
  });

  it("discardPlan removes the staged copies, so applying the plan afterwards is STALE_PLAN", async () => {
    const { sb, library } = await setup();
    const plan = value(await library.planInstall({ names: ["style"] }), ops.planInstall.output);
    expect(await sb.host.fs.exists(plan.opDir)).toBe(true);
    expect(value(await library.discardPlan(plan), ops.discardPlan.output)).toBeUndefined();
    expect(await sb.host.fs.exists(plan.opDir)).toBe(false);
    expect(await library.applyInstall(plan)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
  });

  it("uninstall deletes a managed copy; unmanaged content not named in forcePaths is refused", async () => {
    const { library, home } = await setup();
    await installed(library, "style");
    await put(destFor(home, "skill", "tidy") + "/SKILL.md", "mine\n");
    const report = value(await library.uninstall({ names: ["style", "tidy"] }), ops.uninstall.output);
    expect(report.items.map((i) => [i.name, i.outcome])).toEqual([
      ["style", "deleted"],
      ["tidy", "refused"],
    ]);
    expect(await library.uninstall({ names: ["nothing"] })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("setSkillState turns a skill off in skillOverrides; an agent is REFUSED", async () => {
    const { library, settingsFile } = await setup();
    const report = value(await library.setSkillState(["tidy"], "off"), ops.setSkillState.output);
    expect(report.changed).toEqual([{ name: "tidy", type: "skill", state: "off" }]);
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ skillOverrides: { tidy: "off" } });
    expect(await library.setSkillState(["helper"], "off")).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("migrateParked moves a parked copy back and turns it off; an occupied destination is left in place", async () => {
    const { library, home, settingsFile } = await setup();
    const parked = join(home, ".claude/skills-disabled");
    await put(join(parked, "old/SKILL.md"), "old\n");
    await put(join(parked, "taken/SKILL.md"), "parked\n");
    await put(join(home, ".claude/skills/taken/SKILL.md"), "live\n");
    const plan = value(await library.planMigrateParked(), ops.planMigrateParked.output);
    const report = value(await library.applyMigrateParked(plan), ops.applyMigrateParked.output);
    expect(report.moved).toEqual(["old"]);
    expect(report.leftInPlace.map((l) => l.name)).toEqual(["taken"]);
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ skillOverrides: { old: "off" } });
  });

  it("planSync/applySync refresh a moved source; a plan whose destination changed is STALE_PLAN", async () => {
    const { library, repo, home } = await setup();
    await installed(library, "style");
    repo.commit({ "prompts/style.md": "style v2\n" });

    const plan = value(await library.planSync(), ops.planSync.output);
    const report = value(await library.applySync(plan), ops.applySync.output);
    expect(report.synced.map((s) => s.name)).toEqual(["style"]);
    expect(await readFile(destFor(home, "prompt", "style"), "utf8")).toBe("style v2\n");

    repo.commit({ "prompts/style.md": "style v3\n" });
    const stale = value(await library.planSync({ force: true }), ops.planSync.output);
    await writeFile(destFor(home, "prompt", "style"), "edited meanwhile\n");
    expect(await library.applySync(stale)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    await library.discardPlan(stale);
  });

  it("plans are opaque in the schema: anything without items is rejected", () => {
    expect(ops.applyInstall.input.safeParse({ plan: { items: [] } }).success).toBe(true);
    expect(ops.applyInstall.input.safeParse({ plan: "a plan" }).success).toBe(false);
    expect(ops.applySync.input.safeParse({}).success).toBe(false);
    expect(ops.setSkillState.input.safeParse({ names: ["a"], state: "disabled" }).success).toBe(false);
  });
});
