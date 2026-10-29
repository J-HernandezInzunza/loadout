import { chmod, lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import type { Host } from "../host.ts";
import { createClaudeSettings } from "./settings.ts";

async function setup(wrap: (host: Host) => Host = (h) => h, configDir?: string) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  const settings = createClaudeSettings(host, configDir === undefined ? {} : { configDir: join(sb.root, configDir) });
  const write = async (text: string) => {
    await mkdir(dirname(settings.file), { recursive: true });
    await writeFile(settings.file, text);
  };
  const text = () => readFile(settings.file, "utf8");
  return { sb, settings, write, text };
}

const original = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "opus",
  "permissions": {
    "allow": ["Bash(git status)"],
    "deny": []
  },
  "skillOverrides": {
    "keep": "name-only"
  },
  "statusLine": { "type": "command", "command": "~/bin/status" }
}
`;

describe("Claude settings: skillOverrides edits", () => {
  it("keeps every byte outside the changed key", async () => {
    const { settings, write, text } = await setup();
    await write(original);
    expect(await settings.editSkillOverrides({ review: "off" })).toEqual({ ok: true, value: { changed: true }, warnings: [] });
    expect(await text()).toBe(original.replace('"keep": "name-only"\n', '"keep": "name-only",\n    "review": "off"\n'));

    await settings.editSkillOverrides({ review: null });
    expect(await text()).toBe(original);
    expect(await settings.readSkillOverrides()).toEqual({ ok: true, value: new Map([["keep", "name-only"]]), warnings: [] });
  });

  it("adds the skillOverrides key to a file without one, matching its tab indentation", async () => {
    const { settings, write, text } = await setup();
    await write('{\n\t"model": "opus"\n}\n');
    await settings.editSkillOverrides({ a: "off" });
    expect(await text()).toBe('{\n\t"model": "opus",\n\t"skillOverrides": {\n\t\t"a": "off"\n\t}\n}\n');
  });

  it("creates the file with only skillOverrides when it is missing, and writes nothing when there is nothing to set", async () => {
    const { settings, text } = await setup();
    expect(await settings.readSkillOverrides()).toEqual({ ok: true, value: new Map(), warnings: [] });
    expect(await settings.editSkillOverrides({ a: null })).toMatchObject({ ok: true, value: { changed: false } });
    expect(await readFile(settings.file, "utf8").catch(() => "absent")).toBe("absent");

    await settings.editSkillOverrides({ a: "off" });
    expect(JSON.parse(await text())).toEqual({ skillOverrides: { a: "off" } });
  });

  it("edits an empty object", async () => {
    const { settings, write, text } = await setup();
    await write("{}");
    await settings.editSkillOverrides({ a: "off" });
    expect(JSON.parse(await text())).toEqual({ skillOverrides: { a: "off" } });
  });

  it.each([
    ["broken JSON", '{ "model": "opus", }'],
    ["a comment", '{\n  // mine\n  "model": "opus"\n}\n'],
    ["an array", "[]"],
    ["a skillOverrides that is not an object", '{ "skillOverrides": ["a"] }'],
  ])("refuses %s and never overwrites it", async (_, bad) => {
    const { settings, write, text } = await setup();
    await write(bad);
    expect(await settings.editSkillOverrides({ a: "off" })).toMatchObject({ ok: false, error: { code: "SETTINGS" } });
    expect(await settings.readSkillOverrides()).toMatchObject({ ok: false, error: { code: "SETTINGS" } });
    expect(await text()).toBe(bad);
  });

  it("keeps a symlinked settings.json a symlink, and keeps the file's mode", async () => {
    const { sb, settings, text } = await setup();
    const real = join(sb.root, "dotfiles/claude-settings.json");
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, original);
    await chmod(real, 0o600);
    await mkdir(dirname(settings.file), { recursive: true });
    await symlink(real, settings.file);

    await settings.editSkillOverrides({ a: "off" });
    expect((await lstat(settings.file)).isSymbolicLink()).toBe(true);
    expect(await readlink(settings.file)).toBe(real);
    expect(await text()).toContain('"a": "off"');
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });

  it("re-reads a file Claude Code changed during the edit, and keeps both changes", async () => {
    let reads = 0;
    const { settings, write, text } = await setup((host) => ({
      ...host,
      fs: {
        ...host.fs,
        async readText(path) {
          const t = await host.fs.readText(path);
          // Claude Code writes right after Loadout's first read.
          if (++reads === 1) await host.fs.writeTextAtomic(path, t.replace('"opus"', '"sonnet"'));
          return t;
        },
      },
    }));
    await write(original);
    expect(await settings.editSkillOverrides({ a: "off" })).toMatchObject({ ok: true, value: { changed: true } });
    expect(JSON.parse(await text())).toMatchObject({ model: "sonnet", skillOverrides: { keep: "name-only", a: "off" } });
  });

  it("gives up when the file keeps changing", async () => {
    let n = 0;
    const { settings, write, text } = await setup((host) => ({
      ...host,
      fs: {
        ...host.fs,
        async readText(path) {
          const t = await host.fs.readText(path);
          await host.fs.writeTextAtomic(path, t.replace(/"model": "[^"]*"/, `"model": "m${++n}"`));
          return t;
        },
      },
    }));
    await write(original);
    expect(await settings.editSkillOverrides({ a: "off" })).toMatchObject({
      ok: false,
      error: { code: "SETTINGS", message: expect.stringContaining("kept changing") },
    });
    expect(await text()).not.toContain('"a": "off"');
  });

  it("uses CLAUDE_CONFIG_DIR's settings.json when given one", async () => {
    const { sb, settings } = await setup((h) => h, "claude-config");
    expect(settings.file).toBe(join(sb.root, "claude-config/settings.json"));
    await settings.editSkillOverrides({ a: "off" });
    expect(JSON.parse(await readFile(settings.file, "utf8"))).toEqual({ skillOverrides: { a: "off" } });
    expect(await sb.host.fs.exists(join(sb.host.paths.home, ".claude"))).toBe(false);
  });

  it("leaves the file alone when every change is already in place", async () => {
    const { sb, settings, write } = await setup();
    await write(original);
    expect(await settings.editSkillOverrides({ keep: "name-only", absent: null })).toMatchObject({ ok: true, value: { changed: false } });
    expect(sb.audit.filter((e) => e.kind === "fs")).toEqual([]);
  });
});
