import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { checked } from "../../test/checkedLibrary.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { applyInstall } from "../install/apply.ts";
import { planInstall } from "../install/plan.ts";
import type { CatalogRef } from "../model/model.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
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

async function setup(catalogs: Record<string, Item[]>, extra: CatalogRef[] = []) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const config = createConfigStore(sb.host);
  const refs: CatalogRef[] = [];
  for (const [id, items] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, yaml(items));
    refs.push({ id, kind: "local", path });
  }
  await config.saveConfig({ version: 1, catalogs: [...refs, ...extra], pins: {}, settings: {} });
  const git = createGitClient(sb.host);
  const ctx = { host: sb.host, git, config, receipts: createReceiptStore(sb.host) };
  const install = async (names: string[], catalog?: string) => {
    const p = await planInstall(ctx, { names, ...(catalog !== undefined && { catalog }) });
    if (!p.ok) throw new Error(p.error.message);
    await applyInstall(ctx, p.value);
  };
  const library = checked(createLibrary(sb.host, { git }));
  const list = async (o: Parameters<typeof library.list>[0] = {}) => {
    const r = await library.list(o);
    if (!r.ok) throw new Error(r.error.message);
    expect(ops.list.output.safeParse(r.value).success).toBe(true);
    return r.value;
  };
  return { sb, h, install, library, list, home: sb.host.paths.home };
}

describe("install state in reads", () => {
  it("list reports installed, drifted, unmanaged and not installed, with the receipt and location", async () => {
    const { h, install, list, home } = await setup({
      team: [
        { type: "prompt", name: "fresh", source: gh("prompts/fresh.md") },
        { type: "prompt", name: "edited", source: gh("prompts/edited.md") },
        { type: "prompt", name: "hand", source: gh("prompts/hand.md") },
        { type: "prompt", name: "never", source: gh("prompts/never.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "prompts/fresh.md": "f\n", "prompts/edited.md": "e\n" });
    await install(["fresh", "edited"]);
    await put(destFor(home, "prompt", "edited"), "mine\n");
    await put(destFor(home, "prompt", "hand"), "hand-made\n");

    const records = await list();
    expect(records.map((r) => [r.name, r.installed, r.state, r.receipt?.name ?? null, r.locations])).toEqual([
      ["fresh", true, "installed", "fresh", [destFor(home, "prompt", "fresh")]],
      ["edited", true, "drifted", "edited", [destFor(home, "prompt", "edited")]],
      ["hand", true, "unmanaged", null, [destFor(home, "prompt", "hand")]],
      ["never", false, "not_installed", null, []],
    ]);
  });

  it("RES-07: the losing copy never claims the install the winner has", async () => {
    const { h, install, list, home } = await setup({
      A: [{ type: "prompt", name: "x", source: gh("prompts/a.md") }],
      B: [{ type: "prompt", name: "x", source: gh("prompts/b.md") }],
    });
    h.createRepo("github.com", "o/r").commit({ "prompts/a.md": "a\n", "prompts/b.md": "b\n" });
    await install(["x"]);
    expect((await list()).map((r) => [r.catalog, r.installed, r.state, r.locations])).toEqual([
      ["A", true, "installed", [destFor(home, "prompt", "x")]],
      ["B", false, "not_installed", []],
    ]);
  });

  it("RES-08: show --catalog of the losing copy reports the destination's real install fields", async () => {
    const { h, install, library, home } = await setup({
      A: [{ type: "prompt", name: "x", source: gh("prompts/a.md") }],
      B: [{ type: "prompt", name: "x", source: gh("prompts/b.md") }],
    });
    h.createRepo("github.com", "o/r").commit({ "prompts/a.md": "a\n", "prompts/b.md": "b\n" });
    await install(["x"]);
    const shown = await library.show("x", { catalog: "B" });
    expect(shown).toMatchObject({
      ok: true,
      value: { entry: { catalog: "B", overriddenBy: "A", installed: true, state: "installed", locations: [destFor(home, "prompt", "x")] } },
    });
    expect(shown.ok && ops.show.output.safeParse(shown.value).success).toBe(true);
  });

  it("A26: show's installs lists only receipts of the subject's type", async () => {
    const { sb, h, install, library, home } = await setup({
      team: [
        { type: "skill", name: "review", source: gh("skills/review/SKILL.md") },
        { type: "prompt", name: "review", source: gh("prompts/review.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "skills/review/SKILL.md": "s\n", "prompts/review.md": "p\n" });
    await install(["review"]);
    // A prompt receipt under the same name, as an older install of the other type would leave.
    await createReceiptStore(sb.host).put({
      dest: destFor(home, "prompt", "review"),
      type: "prompt",
      name: "review",
      catalog: { id: "team", key: "k" },
      source: gh("prompts/review.md"),
      commit: null,
      sourceOid: null,
      files: {},
      installedAt: "2026-10-28T12:00:00Z",
    });
    const shown = await library.show("review");
    expect(shown.ok && shown.value.installs.map((r) => r.type)).toEqual(["skill"]);
  });

  it("reports disabled and the read-only values (Q14 A) from skillOverrides, never for an agent", async () => {
    const { h, install, list, home } = await setup({
      team: [
        { type: "skill", name: "s", source: gh("skills/s/SKILL.md") },
        { type: "skill", name: "n", source: gh("skills/n/SKILL.md") },
        { type: "agent", name: "s2", source: gh("agents/s2.md") },
        { type: "prompt", name: "p", source: gh("prompts/p.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "skills/s/SKILL.md": "s\n", "skills/n/SKILL.md": "n\n", "agents/s2.md": "a\n", "prompts/p.md": "p\n" });
    await install(["s", "n", "s2", "p"]);
    await put(join(home, ".claude/settings.json"), JSON.stringify({ skillOverrides: { s: "off", n: "name-only", s2: "name-only", p: "user-invocable-only" } }));
    expect((await list()).map((r) => [r.name, r.disabled, r.skillOverride])).toEqual([
      ["s", true, null],
      ["n", false, "name-only"],
      ["s2", false, null],
      ["p", false, "user-invocable-only"],
    ]);
  });

  it("UPD-06: list({ checkRemote }) marks a moved source stale; plain list never reaches the network", async () => {
    const { sb, h, install, list } = await setup({
      team: [
        { type: "prompt", name: "moved", source: gh("prompts/moved.md") },
        { type: "prompt", name: "still", source: gh("prompts/still.md") },
      ],
    });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "prompts/moved.md": "1\n", "prompts/still.md": "s\n" });
    await install(["moved", "still"]);
    remote.commit({ "prompts/moved.md": "2\n" });

    const procs = () => sb.audit.filter((e) => e.kind === "proc:start").length;
    const before = procs();
    expect((await list()).map((r) => r.state)).toEqual(["installed", "installed"]);
    expect(procs()).toBe(before);
    expect((await list({ checkRemote: true })).map((r) => [r.name, r.state])).toEqual([
      ["moved", "stale"],
      ["still", "installed"],
    ]);
    expect(procs()).toBeGreaterThan(before);
  });

  it("scan() reports the install dirs and whether a catalog has each item; refresh() clones remote catalogs", async () => {
    const { sb, h, library, home } = await setup(
      { team: [{ type: "prompt", name: "known", source: gh("prompts/known.md") }] },
      [{ id: "remote", kind: "remote", repo: "git@github.com:o/cat.git", yamlPath: "library.yaml", branch: "main", protected: false }],
    );
    await put(destFor(home, "prompt", "known"));
    await put(destFor(home, "prompt", "stray"));
    const scanned = await library.scan();
    expect(scanned.ok && scanned.value.items.map((i) => [i.name, i.inCatalog])).toEqual([
      ["known", true],
      ["stray", false],
    ]);
    expect(scanned.ok && ops.scan.output.safeParse(scanned.value).success).toBe(true);

    h.createRepo("github.com", "o/cat").commit({ "library.yaml": yaml([{ type: "prompt", name: "r", source: gh("prompts/r.md") }]) });
    expect(await library.refresh()).toMatchObject({ ok: true, value: [{ id: "remote", outcome: "cloned" }] });
    expect(await sb.host.fs.exists(join(sb.host.paths.appData, "clones/remote/library.yaml"))).toBe(true);
  });
});
