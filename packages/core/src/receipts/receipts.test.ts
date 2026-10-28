import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import type { Host } from "../host.ts";
import { createReceiptStore, type ReceiptV2 } from "./receipts.ts";

function receipt(dest: string, over: Partial<ReceiptV2> = {}): ReceiptV2 {
  return {
    dest,
    type: "skill",
    name: dest.split("/").at(-1)!,
    catalog: { id: "team", key: "git@bitbucket.org:ws/lib.git#library.yaml@main" },
    source: "https://bitbucket.org/ws/lib/src/main/skills/x/SKILL.md",
    commit: "a".repeat(40),
    sourceOid: "b".repeat(40),
    files: { "SKILL.md": "c".repeat(64) },
    installedAt: "2026-10-28T12:00:00.000Z",
    ...over,
  };
}

async function setup(wrap: (host: Host) => Host = (h) => h) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  const file = join(host.paths.appData, "receipts.json");
  const store = createReceiptStore(host);
  const all = async () => {
    const r = await store.all();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  return { sb, host, file, store, all, skills: join(host.paths.home, ".claude", "skills") };
}

describe("receipt store", () => {
  it("puts, gets, replaces and deletes receipts by dest, in a v2 file sorted by dest", async () => {
    const { store, all, file, skills } = await setup();
    expect(await store.all()).toEqual({ ok: true, value: [], warnings: [] });

    await store.put(receipt(join(skills, "zeta")));
    await store.put(receipt(join(skills, "alpha")));
    await store.put(receipt(join(skills, "zeta"), { commit: null, sourceOid: null }));
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.installs.map((r: ReceiptV2) => r.dest)).toEqual([join(skills, "alpha"), join(skills, "zeta")]);
    expect(await store.get(join(skills, "zeta"))).toMatchObject({ ok: true, value: { commit: null } });

    expect(await store.delete(join(skills, "zeta"))).toMatchObject({ ok: true });
    expect(await store.delete(join(skills, "zeta"))).toMatchObject({ ok: true });
    expect(await store.get(join(skills, "zeta"))).toEqual({ ok: true, value: null, warnings: [] });
    expect(await all()).toEqual([receipt(join(skills, "alpha"))]);
  });

  it("LOCK-02: 50 concurrent puts all survive", async () => {
    const { store, all, skills } = await setup();
    const dests = Array.from({ length: 50 }, (_, i) => join(skills, `s${String(i).padStart(2, "0")}`));
    const results = await Promise.all(dests.map((d) => store.put(receipt(d))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await all()).map((r) => r.dest)).toEqual(dests);
  });

  it("LOCK-02: interleaved puts and deletes apply in call order", async () => {
    const { store, all, skills } = await setup();
    const a = join(skills, "a");
    const b = join(skills, "b");
    await Promise.all([store.put(receipt(a)), store.put(receipt(b)), store.delete(a), store.put(receipt(b, { name: "B" }))]);
    expect(await all()).toEqual([receipt(b, { name: "B" })]);
  });

  it("LOCK-02: a crash mid-write leaves the old file, and the next write still lands", async () => {
    let crash = false;
    const { store, all, file, skills } = await setup((host) => ({
      ...host,
      fs: {
        ...host.fs,
        async writeTextAtomic(path, text) {
          if (!crash) return host.fs.writeTextAtomic(path, text);
          // Dies after writing half the temp file, before the rename.
          await writeFile(join(dirname(path), ".receipts.json.crash.tmp"), text.slice(0, text.length / 2));
          throw new Error("killed");
        },
      },
    }));
    await store.put(receipt(join(skills, "a")));
    const before = await readFile(file, "utf8");

    crash = true;
    await expect(store.put(receipt(join(skills, "b")))).rejects.toThrow("killed");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await all()).toEqual([receipt(join(skills, "a"))]);

    crash = false;
    expect(await store.put(receipt(join(skills, "c")))).toMatchObject({ ok: true });
    expect((await all()).map((r) => r.name)).toEqual(["a", "c"]);
    expect(await readdir(dirname(file))).toContain("receipts.json");
  });

  it.each([
    ["the Python CLI's v1 file", JSON.stringify({ version: 1, installs: {} })],
    ["a future version", JSON.stringify({ version: 3, installs: [] })],
    ["broken JSON", "{"],
    ["a v2 file with an unknown field", JSON.stringify({ version: 2, installs: [{ ...receipt("/x"), scope: "global" }] })],
  ])("reads %s as empty with a warning, and never overwrites it", async (_, text) => {
    const { store, file, host } = await setup();
    await host.fs.mkdirp(host.paths.appData);
    await writeFile(file, text);

    expect(await store.all()).toMatchObject({ ok: true, value: [], warnings: [{ message: expect.stringContaining("can't be read") }] });
    expect(await store.get("/x")).toMatchObject({ ok: true, value: null, warnings: [{}] });
    for (const write of [store.put(receipt("/x")), store.delete("/x")]) {
      expect(await write).toMatchObject({ ok: false, error: { code: "RECEIPTS_INVALID" } });
    }
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("audits each write", async () => {
    const { sb, store, file } = await setup();
    await store.put(receipt("/x"));
    await store.delete("/nothing-there");
    expect(sb.audit.filter((e) => e.kind === "fs")).toEqual([{ kind: "fs", op: "write", path: file }]);
  });
});
