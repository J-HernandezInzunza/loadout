import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { contentHashV1, fileManifest } from "../receipts/hash.ts";
import { createReceiptStore, type ReceiptV2 } from "../receipts/receipts.ts";
import { destFor, destState, installDirs, readLegacyInstalls, scanInstallDirs } from "./scan.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function setup() {
  const sb = await createSandbox();
  const home = sb.host.paths.home;
  const dirs = installDirs(home);
  const store = createReceiptStore(sb.host);
  /** Writes a receipt for what is at `dest` now, as an install would. */
  const receive = async (type: ReceiptV2["type"], name: string): Promise<ReceiptV2> => {
    const dest = destFor(home, type, name);
    const receipt: ReceiptV2 = {
      dest,
      type,
      name,
      catalog: { id: "team", key: "k" },
      source: "/src",
      commit: null,
      sourceOid: null,
      files: await fileManifest(sb.host, dest),
      installedAt: "2026-10-28T12:00:00.000Z",
    };
    await store.put(receipt);
    return receipt;
  };
  const scan = async (opts?: Parameters<typeof scanInstallDirs>[2]) => {
    const r = await scanInstallDirs(sb.host, store, opts);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  return { sb, home, dirs, store, receive, scan };
}

describe("install destinations", () => {
  it("INST-01: skills are folders, agents and prompts are .md files under ~/.claude", () => {
    expect(destFor("/h", "skill", "review")).toBe("/h/.claude/skills/review");
    expect(destFor("/h", "agent", "review")).toBe("/h/.claude/agents/review.md");
    expect(destFor("/h", "prompt", "review")).toBe("/h/.claude/commands/review.md");
  });
});

describe("destState", () => {
  it("INST-08 (rebuild): reads installed, or drifted with each modified, added and deleted file", async () => {
    const { sb, home, receive } = await setup();
    const dest = destFor(home, "skill", "s");
    await put(join(dest, "SKILL.md"), "s\n");
    await put(join(dest, "references/a.md"), "a\n");
    await put(join(dest, "references/b.md"), "b\n");
    const receipt = await receive("skill", "s");
    expect(await destState(sb.host, dest, receipt)).toEqual({ state: "installed", receipt });

    await put(join(dest, "SKILL.md"), "edited\n");
    await put(join(dest, "notes.md"), "mine\n");
    await sb.host.fs.remove(join(dest, "references/b.md"));
    expect(await destState(sb.host, dest, receipt)).toEqual({
      state: "drifted",
      receipt,
      edits: { modified: ["SKILL.md"], added: ["notes.md"], deleted: ["references/b.md"] },
    });
  });

  it("classifies what has no receipt: absent, a symlink, the Python CLI's copy (as installed or edited), or foreign", async () => {
    const { sb, home } = await setup();
    const dest = destFor(home, "prompt", "p");
    expect(await destState(sb.host, dest, null)).toEqual({ state: "absent" });

    await put(dest, "p\n");
    expect(await destState(sb.host, dest, null)).toEqual({ state: "unmanaged", origin: "foreign" });
    const legacy = new Map([[dest, await contentHashV1(sb.host, dest)]]);
    expect(await destState(sb.host, dest, null, legacy)).toEqual({ state: "unmanaged", origin: "python-cli" });
    await put(dest, "edited\n");
    expect(await destState(sb.host, dest, null, legacy)).toEqual({ state: "unmanaged", origin: "python-cli-edited" });

    const link = destFor(home, "skill", "library");
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(sb.root, "tool"), link);
    expect(await destState(sb.host, link, null)).toEqual({ state: "unmanaged", origin: "symlink" });
  });
});

describe("scanInstallDirs", () => {
  it("SCAN-01 (rebuild): lists top-level items only, skipping dot names and synced", async () => {
    const { dirs, scan } = await setup();
    await put(join(dirs.skill, "mine/SKILL.md"));
    await put(join(dirs.skill, "mine/nested/inner/SKILL.md"));
    await put(join(dirs.skill, ".trash/old/SKILL.md"));
    await put(join(dirs.skill, "Synced/remote/SKILL.md"));
    await put(join(dirs.skill, "stray.txt"));
    await put(join(dirs.agent, "helper.md"));
    await put(join(dirs.agent, "notes.txt"));
    await put(join(dirs.prompt, "review.md"));
    await put(join(dirs.prompt, "team/deploy.md"));

    const { items } = await scan();
    expect(items.map((i) => [i.type, i.name])).toEqual([
      ["skill", "mine"],
      ["agent", "helper"],
      ["prompt", "review"],
      ["prompt", "team"],
    ]);
    expect(items.every((i) => i.state.state === "unmanaged" && i.state.origin === "foreign")).toBe(true);
  });

  it("reports each origin, never following a symlink", async () => {
    const { sb, home, dirs, receive, scan } = await setup();
    await put(join(dirs.skill, "managed/SKILL.md"));
    await receive("skill", "managed");
    await put(join(dirs.skill, "by-cli/SKILL.md"), "cli\n");
    await put(join(dirs.skill, "cli-edited/SKILL.md"), "cli\n");
    await put(join(dirs.skill, "hand-copied/SKILL.md"));
    await put(join(dirs.skill + "-disabled", "parked/SKILL.md"));
    await put(join(sb.root, "tool/inside/SKILL.md"));
    await symlink(join(sb.root, "tool"), join(dirs.skill, "library"));

    const installs = join(sb.root, "tool", ".installs.json");
    await put(
      installs,
      JSON.stringify({
        version: 1,
        installs: [
          { dest: destFor(home, "skill", "by-cli"), content_hash: await contentHashV1(sb.host, destFor(home, "skill", "by-cli")) },
          { dest: destFor(home, "skill", "cli-edited"), content_hash: "sha256:" + "0".repeat(64) },
        ],
      }),
    );

    const { items } = await scan({ legacyInstalls: installs, inCatalog: (_, name) => name === "hand-copied" });
    expect(items.map((i) => [i.name, i.state.state === "unmanaged" ? i.state.origin : i.state.state, i.inCatalog])).toEqual([
      ["by-cli", "python-cli", false],
      ["cli-edited", "python-cli-edited", false],
      ["hand-copied", "foreign", true],
      ["library", "symlink", false],
      ["managed", "installed", false],
      ["parked", "parked-by-python-cli", false],
    ]);
    expect(items.find((i) => i.name === "parked")!.path).toBe(join(dirs.skill + "-disabled", "parked"));
  });

  it("SYNC-06: reports receipts whose destination is gone, and leaves them alone", async () => {
    const { sb, dirs, store, receive, scan } = await setup();
    await put(join(dirs.agent, "gone.md"));
    await put(join(dirs.agent, "kept.md"));
    const gone = await receive("agent", "gone");
    await receive("agent", "kept");
    await sb.host.fs.remove(join(dirs.agent, "gone.md"));

    const report = await scan();
    expect(report.missing).toEqual([gone]);
    expect(report.items.map((i) => i.name)).toEqual(["kept"]);
    expect(await store.all()).toMatchObject({ ok: true, value: [{}, {}] });
  });

  it("works when no install dir exists yet", async () => {
    const { scan } = await setup();
    expect(await scan()).toEqual({ items: [], missing: [] });
  });
});

describe("readLegacyInstalls", () => {
  it("reads the CLI's v1 receipts, and treats anything else as no hints", async () => {
    const { sb } = await setup();
    const at = (name: string) => join(sb.root, name);
    await put(at("v1.json"), JSON.stringify({ version: 1, installs: [{ dest: "/d", content_hash: "sha256:x" }, { dest: 3 }] }));
    await put(at("v2.json"), JSON.stringify({ version: 2, installs: [] }));
    await put(at("bad.json"), "{");
    expect(await readLegacyInstalls(sb.host, at("v1.json"))).toEqual(new Map([["/d", "sha256:x"]]));
    for (const f of ["v2.json", "bad.json", "absent.json"]) expect(await readLegacyInstalls(sb.host, at(f))).toEqual(new Map());
    expect(await readLegacyInstalls(sb.host, undefined)).toEqual(new Map());
  });
});
