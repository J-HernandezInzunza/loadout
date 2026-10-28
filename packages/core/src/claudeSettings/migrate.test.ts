import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import type { Host } from "../host.ts";
import { createClaudeSettings } from "./settings.ts";
import { applyMigrateParked, planMigrateParked } from "./migrate.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const exdev = () => Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));

async function setup(wrap: (host: Host) => Host = (h) => h) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  const settings = createClaudeSettings(host);
  const skills = join(sb.host.paths.home, ".claude/skills");
  const parked = `${skills}-disabled`;
  const migrate = async () => {
    const plan = await planMigrateParked(host);
    if (!plan.ok) throw new Error(plan.error.message);
    return { plan: plan.value, applied: await applyMigrateParked({ host, settings }, plan.value) };
  };
  const overrides = async () => {
    const r = await settings.readSkillOverrides();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  return { sb, settings, skills, parked, migrate, overrides };
}

describe("migrating skills the Python CLI parked", () => {
  it("rule 7: lists every parked copy, moves each back and turns it off", async () => {
    const { sb, skills, parked, migrate, overrides } = await setup();
    await put(join(parked, "a/SKILL.md"), "a\n");
    await put(join(parked, "b/SKILL.md"), "b\n");
    await put(join(parked, "b/ref/x.md"), "x\n");
    await put(join(parked, ".DS_Store"));

    const { plan, applied } = await migrate();
    expect(plan.items).toEqual([
      { name: "a", from: join(parked, "a"), to: join(skills, "a"), occupied: false },
      { name: "b", from: join(parked, "b"), to: join(skills, "b"), occupied: false },
    ]);
    expect(applied).toEqual({ ok: true, value: { moved: ["a", "b"], leftInPlace: [] }, warnings: [] });
    expect(await readFile(join(skills, "b/ref/x.md"), "utf8")).toBe("x\n");
    expect(await readdir(parked)).toEqual([".DS_Store"]);
    expect(await overrides()).toEqual(new Map([["a", "off"], ["b", "off"]]));
    expect(sb.audit).toContainEqual({ kind: "fs", op: "move", path: join(parked, "a"), to: join(skills, "a") });
  });

  it("rule 7: leaves a copy whose destination is taken, and reports it", async () => {
    const { skills, parked, migrate, overrides } = await setup();
    await put(join(parked, "a/SKILL.md"), "parked\n");
    await put(join(skills, "a/SKILL.md"), "active\n");
    const { plan, applied } = await migrate();
    expect(plan.items[0]!.occupied).toBe(true);
    expect(applied).toMatchObject({ ok: true, value: { moved: [], leftInPlace: [{ name: "a", reason: `${join(skills, "a")} is already taken` }] } });
    expect(await readFile(join(parked, "a/SKILL.md"), "utf8")).toBe("parked\n");
    expect(await readFile(join(skills, "a/SKILL.md"), "utf8")).toBe("active\n");
    expect(await overrides()).toEqual(new Map());
  });

  it("rule 7 (DIS-03): across volumes, copies, verifies, then deletes the original", async () => {
    const { sb, skills, parked, migrate } = await setup((host) => ({ ...host, fs: { ...host.fs, rename: exdev } }));
    await put(join(parked, "a/SKILL.md"), "a\n");
    await put(join(parked, "a/deep/n.md"), "n\n");
    expect((await migrate()).applied).toMatchObject({ ok: true, value: { moved: ["a"] } });
    expect(await readFile(join(skills, "a/deep/n.md"), "utf8")).toBe("n\n");
    expect(await readdir(parked)).toEqual([]);
    expect(sb.audit.filter((e) => e.kind === "fs").map((e) => e.kind === "fs" && e.op)).toEqual(["write", "copy-tree", "delete"]);
  });

  it("rule 7 (DIS-03): a copy that doesn't match is discarded and the original kept", async () => {
    const { skills, parked, migrate } = await setup((host) => ({
      ...host,
      fs: {
        ...host.fs,
        rename: exdev,
        // A copy that comes out different from its source.
        copyFile: async (from, to) => {
          await host.fs.copyFile(from, to);
          await host.fs.writeTextAtomic(to, "garbled\n");
        },
      },
    }));
    await put(join(parked, "a/SKILL.md"), "a\n");
    expect((await migrate()).applied).toMatchObject({
      ok: true,
      value: { moved: [], leftInPlace: [{ name: "a", reason: "the copy didn't match the original, so the original was kept" }] },
    });
    expect(await readFile(join(parked, "a/SKILL.md"), "utf8")).toBe("a\n");
    expect(await readdir(skills)).toEqual([]);
  });

  it("leaves a cross-volume copy with symlinks for the user to move", async () => {
    const { skills, parked, migrate } = await setup((host) => ({ ...host, fs: { ...host.fs, rename: exdev } }));
    await put(join(parked, "a/SKILL.md"), "a\n");
    await symlink("SKILL.md", join(parked, "a/link.md"));
    expect((await migrate()).applied).toMatchObject({ ok: true, value: { moved: [], leftInPlace: [{ name: "a", reason: expect.stringContaining("symlinks") }] } });
    expect(await readdir(join(parked, "a"))).toEqual(["SKILL.md", "link.md"]);
    expect(await readdir(skills)).toEqual([]);
  });

  it("writes off before moving, and moves nothing when settings can't be edited", async () => {
    const { settings, parked, migrate } = await setup();
    await put(join(parked, "a/SKILL.md"));
    await put(settings.file, "{ broken");
    expect((await migrate()).applied).toMatchObject({ ok: false, error: { code: "SETTINGS" } });
    expect(await readdir(parked)).toEqual(["a"]);
  });

  it("does nothing when nothing is parked", async () => {
    const { sb, migrate } = await setup();
    expect(await migrate()).toEqual({ plan: { items: [] }, applied: { ok: true, value: { moved: [], leftInPlace: [] }, warnings: [] } });
    expect(sb.audit).toEqual([]);
  });
});
