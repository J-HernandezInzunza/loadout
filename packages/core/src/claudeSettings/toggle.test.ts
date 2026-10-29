import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { destFor } from "../scan/scan.ts";
import { createClaudeSettings } from "./settings.ts";
import { managedSkillOverrides, setSkillState, type ToggleCtx } from "./toggle.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function setup(entries: { type: "skill" | "agent" | "prompt"; name: string }[] = []) {
  const sb = await createSandbox();
  const config = createConfigStore(sb.host);
  const catalog = join(sb.root, "team.yaml");
  const section = (t: string) =>
    entries.filter((e) => e.type === t).map((e) => `    - name: ${e.name}\n      description: d\n      source: /src/${e.name}/SKILL.md\n`).join("");
  await put(catalog, `library:\n  skills:\n${section("skill")}  agents:\n${section("agent")}  prompts:\n${section("prompt")}`);
  await config.saveConfig({ version: 1, catalogs: [{ id: "team", kind: "local", path: catalog }], pins: {}, settings: {} });
  const settings = createClaudeSettings(sb.host);
  const ctx: ToggleCtx = { host: sb.host, config, settings };
  const overrides = async () => JSON.parse(await readFile(settings.file, "utf8")).skillOverrides as Record<string, string>;
  return { sb, ctx, settings, overrides, home: sb.host.paths.home };
}

describe("setSkillState", () => {
  it("rule 1: keys the override by the entry name, never a SKILL.md frontmatter name", async () => {
    const { ctx, overrides, home } = await setup([{ type: "skill", name: "review" }]);
    await put(join(destFor(home, "skill", "review"), "SKILL.md"), "---\nname: Code Review Helper\n---\n");
    expect(await setSkillState(ctx, ["review"], "off")).toEqual({
      ok: true,
      value: { changed: [{ name: "review", type: "skill", state: "off" }], unchanged: [], readOnly: [] },
      warnings: [],
    });
    expect(await overrides()).toEqual({ review: "off" });
  });

  it("rule 1: turning on deletes the key, an explicit \"on\" included; repeating a state changes nothing", async () => {
    const { ctx, settings, overrides } = await setup([
      { type: "skill", name: "a" },
      { type: "prompt", name: "p" },
    ]);
    await setSkillState(ctx, ["a", "p"], "off");
    expect(await overrides()).toEqual({ a: "off", p: "off" });
    expect(await setSkillState(ctx, ["a"], "off")).toMatchObject({ ok: true, value: { changed: [], unchanged: ["a"] } });

    await setSkillState(ctx, ["a"], "on");
    expect(await overrides()).toEqual({ p: "off" });
    await settings.editSkillOverrides({ p: "on" });
    expect(await setSkillState(ctx, ["p"], "on")).toMatchObject({ ok: true, value: { changed: [{ name: "p", state: "on" }] } });
    expect(await overrides()).toEqual({});
    expect(await setSkillState(ctx, ["p"], "on")).toMatchObject({ ok: true, value: { changed: [], unchanged: ["p"] } });
  });

  it("rule 5: one key per name, covering every copy of that name", async () => {
    const { sb, ctx, overrides } = await setup([{ type: "skill", name: "shared" }]);
    const second = join(sb.root, "mine.yaml");
    await put(second, "library:\n  skills:\n    - name: shared\n      description: d\n      source: /other/shared/SKILL.md\n");
    await ctx.config.updateConfig((c) => ({ ...c, catalogs: [{ id: "mine", kind: "local", path: second }, ...c.catalogs] }));
    expect(await setSkillState(ctx, ["shared"], "off")).toMatchObject({ ok: true, value: { changed: [{ name: "shared", type: "skill" }] } });
    expect(await overrides()).toEqual({ shared: "off" });
  });

  it("Q15 A: refuses agents, and checks every name before writing anything", async () => {
    const { ctx, settings } = await setup([
      { type: "skill", name: "a" },
      { type: "agent", name: "helper" },
    ]);
    expect(await setSkillState(ctx, ["a", "helper"], "off")).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await setSkillState(ctx, ["a", "nope"], "off")).toMatchObject({ ok: false, error: { code: "NOT_FOUND", query: "nope" } });
    expect(await settings.readSkillOverrides()).toEqual({ ok: true, value: new Map(), warnings: [] });
  });

  it("rule 6: toggles unmanaged skills and prompts found on disk", async () => {
    const { ctx, overrides, home } = await setup();
    await put(join(destFor(home, "skill", "hand-made"), "SKILL.md"));
    await put(destFor(home, "prompt", "notes"));
    await put(destFor(home, "agent", "bot"));
    expect(await setSkillState(ctx, ["hand-made", "notes"], "off")).toMatchObject({
      ok: true,
      value: { changed: [{ name: "hand-made", type: "skill" }, { name: "notes", type: "prompt" }] },
    });
    expect(await overrides()).toEqual({ "hand-made": "off", notes: "off" });
    expect(await setSkillState(ctx, ["bot"], "off")).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("Q14 A: leaves name-only and user-invocable-only alone and reports them", async () => {
    const { ctx, settings, overrides } = await setup([
      { type: "skill", name: "a" },
      { type: "skill", name: "b" },
      { type: "skill", name: "c" },
    ]);
    await settings.editSkillOverrides({ a: "name-only", b: "user-invocable-only" });
    expect(await setSkillState(ctx, ["a", "b", "c"], "off")).toMatchObject({
      ok: true,
      value: {
        changed: [{ name: "c" }],
        readOnly: [
          { name: "a", value: "name-only" },
          { name: "b", value: "user-invocable-only" },
        ],
      },
    });
    expect(await overrides()).toEqual({ a: "name-only", b: "user-invocable-only", c: "off" });
  });

  it("passes a settings refusal through", async () => {
    const { ctx, settings } = await setup([{ type: "skill", name: "a" }]);
    await put(settings.file, "{ broken");
    expect(await setSkillState(ctx, ["a"], "off")).toMatchObject({ ok: false, error: { code: "SETTINGS" } });
  });
});

describe("managedSkillOverrides", () => {
  it("rule 4: reads the managed settings' overrides for doctor, and treats a missing or broken file as none", async () => {
    const { sb } = await setup();
    const managed = join(sb.root, "managed-settings.json");
    expect(await managedSkillOverrides(sb.host, managed)).toEqual(new Map());
    await put(managed, JSON.stringify({ skillOverrides: { review: "off", deploy: "name-only" } }));
    expect(await managedSkillOverrides(sb.host, managed)).toEqual(new Map([["review", "off"], ["deploy", "name-only"]]));
    await put(managed, "{");
    expect(await managedSkillOverrides(sb.host, managed)).toEqual(new Map());
  });
});
