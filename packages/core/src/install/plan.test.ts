import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore, type AppConfigV1 } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { fileManifest } from "../receipts/hash.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { discardPlan, planInstall, type InstallCtx } from "./plan.ts";

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
  await config.saveConfig({ version: 1, catalogs: refs, pins: {}, settings: {} } satisfies AppConfigV1);
  const ctx: InstallCtx = { host: sb.host, git: createGitClient(sb.host), config, receipts: createReceiptStore(sb.host) };
  const plan = async (names: string[], catalog?: string) => {
    const r = await planInstall(ctx, { names, ...(catalog !== undefined && { catalog }) });
    if (!r.ok) throw new Error(r.error.message);
    return r;
  };
  return { sb, h, ctx, plan, home: sb.host.paths.home };
}

describe("planInstall", () => {
  it("RES-05: resolves every name before fetching anything", async () => {
    const { sb, h, ctx } = await setup({ team: [{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }] });
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n" });
    const res = await planInstall(ctx, { names: ["a", "nope"] });
    expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND", query: "nope" } });
    expect(sb.audit.filter((e) => e.kind === "proc:start")).toEqual([]);
    expect(await sb.host.fs.exists(join(sb.host.paths.appData, "tmp"))).toBe(false);
  });

  it("DEP-06: merges closures, dependencies first, each (type, name) once, with who required it", async () => {
    const { h, plan } = await setup({
      team: [
        { type: "skill", name: "a", source: gh("skills/a/SKILL.md"), requires: ["skill:c", "prompt:p"] },
        { type: "skill", name: "b", source: gh("skills/b/SKILL.md"), requires: ["skill:c"] },
        { type: "skill", name: "c", source: gh("skills/c/SKILL.md") },
        { type: "prompt", name: "p", source: gh("prompts/p.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({
      "skills/a/SKILL.md": "a\n",
      "skills/b/SKILL.md": "b\n",
      "skills/c/SKILL.md": "c\n",
      "prompts/p.md": "p\n",
    });
    const { value } = await plan(["a", "b"]);
    expect(value.items.map((i) => [i.type, i.name, i.requiredBy])).toEqual([
      ["skill", "c", ["a", "b"]],
      ["prompt", "p", ["a"]],
      ["skill", "a", []],
      ["skill", "b", []],
    ]);
    expect(value.items.every((i) => i.status === "ready")).toBe(true);
  });

  it("INST-05 (rebuild): previews each destination's files, marking a new install", async () => {
    const { h, plan, home } = await setup({ team: [{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }] });
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/a/ref.md": "r\n" });
    const { value } = await plan(["a"]);
    expect(value.items).toEqual([
      expect.objectContaining({
        type: "skill",
        name: "a",
        catalog: "team",
        dest: destFor(home, "skill", "a"),
        state: "absent",
        needsConsent: false,
        status: "ready",
        preview: { kind: "files", newInstall: true, added: [], removed: [], modified: [], editedLocally: [] },
      }),
    ]);
    expect(Object.keys(value.items[0]!.fetched!.files)).toEqual(["SKILL.md", "ref.md"]);
  });

  it("INST-03: lists added, removed and modified files, and which of them the user edited", async () => {
    const { sb, h, ctx, plan, home } = await setup({ team: [{ type: "skill", name: "a", source: gh("skills/a/SKILL.md") }] });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n", "skills/a/old.md": "old\n", "skills/a/keep.md": "k\n" });
    const dest = destFor(home, "skill", "a");
    for (const [f, t] of [["SKILL.md", "a\n"], ["old.md", "old\n"], ["keep.md", "k\n"]] as const) await put(join(dest, f), t);
    await ctx.receipts.put({
      dest,
      type: "skill",
      name: "a",
      catalog: { id: "team", key: "k" },
      source: gh("skills/a/SKILL.md"),
      commit: remote.head(),
      sourceOid: null,
      files: await fileManifest(sb.host, dest),
      installedAt: "2026-10-28T12:00:00.000Z",
    });
    // The user edits two files and adds one; upstream changes SKILL.md, drops old.md, adds new.md.
    await put(join(dest, "SKILL.md"), "mine\n");
    await put(join(dest, "old.md"), "my old\n");
    await put(join(dest, "notes.md"), "notes\n");
    remote.commit({ "skills/a/SKILL.md": "a2\n", "skills/a/old.md": null, "skills/a/new.md": "n\n" });

    const { value } = await plan(["a"]);
    expect(value.items[0]).toMatchObject({
      state: "drifted",
      needsConsent: false,
      preview: { kind: "files", newInstall: false, added: ["new.md"], removed: ["notes.md", "old.md"], modified: ["SKILL.md"], editedLocally: ["SKILL.md", "notes.md", "old.md"] },
    });
  });

  it("INST-02 (rebuild, Q8 A): an unmanaged destination needs consent; a managed one doesn't", async () => {
    const { h, plan, home } = await setup({
      team: [
        { type: "prompt", name: "p", source: gh("prompts/p.md") },
        { type: "agent", name: "g", source: gh("agents/g.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n", "agents/g.md": "g\n" });
    await put(destFor(home, "prompt", "p"), "hand-made\n");
    const { value } = await plan(["p", "g"]);
    expect(value.items.map((i) => [i.name, i.state, i.origin, i.needsConsent])).toEqual([
      ["p", "unmanaged", "foreign", true],
      ["g", "absent", undefined, false],
    ]);
    expect(value.items[0]!.preview).toMatchObject({ newInstall: false, modified: ["p.md"], editedLocally: [] });
  });

  it("INST-05 (Q5 A): an unreachable source keeps a destination-only preview instead of failing the plan", async () => {
    const { h, plan } = await setup({
      team: [
        { type: "skill", name: "a", source: gh("skills/a/SKILL.md") },
        { type: "skill", name: "far", source: "https://github.com/o/offline/blob/main/SKILL.md" },
        { type: "skill", name: "broken", source: gh("skills/none/SKILL.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n" });
    const { value } = await plan(["a", "far", "broken"]);
    expect(value.items.map((i) => [i.name, i.status, i.preview.kind])).toEqual([
      ["a", "ready", "files"],
      ["far", "unreachable", "destination-only"],
      ["broken", "failed", "destination-only"],
    ]);
    expect(value.items[1]!.reason).toMatch(/^clone failed for o\/offline: /);
    expect(value.items[2]!.reason).toBe("referenced file missing in repo: skills/none/SKILL.md");
  });

  it("A27: carries override provenance per item", async () => {
    const { h, plan } = await setup({
      mine: [{ type: "prompt", name: "p", source: gh("prompts/mine.md") }],
      team: [
        { type: "prompt", name: "p", source: gh("prompts/p.md") },
        { type: "prompt", name: "q", source: gh("prompts/q.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "prompts/mine.md": "m\n", "prompts/p.md": "p\n", "prompts/q.md": "q\n" });
    const { value } = await plan(["p", "q"]);
    expect(value.items.map((i) => [i.name, i.catalog, i.provenance])).toEqual([
      ["p", "mine", { overrides: ["team"], overriddenBy: null, pinned: false }],
      ["q", "team", { overrides: [], overriddenBy: null, pinned: false }],
    ]);
  });

  it("DEP-07 (rebuild): a skill turned off still brings its dependencies", async () => {
    const { h, plan, home } = await setup({
      team: [
        { type: "skill", name: "a", source: gh("skills/a/SKILL.md"), requires: ["skill:c"] },
        { type: "skill", name: "c", source: gh("skills/c/SKILL.md") },
      ],
    });
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/c/SKILL.md": "c\n" });
    await put(join(home, ".claude/settings.json"), JSON.stringify({ skillOverrides: { a: "off" } }));
    const { value } = await plan(["a"]);
    expect(value.items.map((i) => [i.name, i.status])).toEqual([
      ["c", "ready"],
      ["a", "ready"],
    ]);
  });

  it("fingerprints the plan and stages inside one operation that discardPlan removes", async () => {
    const { sb, h, plan } = await setup({ team: [{ type: "prompt", name: "p", source: gh("prompts/p.md") }] });
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n" });
    const a = (await plan(["p"])).value;
    const b = (await plan(["p"])).value;
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.items[0]!.fetched!.staged.startsWith(a.opDir + "/")).toBe(true);
    await discardPlan(sb.host, a);
    expect(await sb.host.fs.exists(a.opDir)).toBe(false);
    expect(await sb.host.fs.exists(b.opDir)).toBe(true);
  });
});
