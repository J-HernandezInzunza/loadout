import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore, type AppConfigV1 } from "./config.ts";
import { applyImport, planImport } from "./import.ts";

const { cases } = loadGolden("registry");
type GoldenCatalog = NonNullable<(typeof cases)[number]["catalogs"]>[number];

/** The CLI's normalized catalog as config.json stores it: no gitCommit, defaults explicit. */
const asConfig = (c: GoldenCatalog): AppConfigV1["catalogs"][number] =>
  c.kind === "local"
    ? { id: c.id, kind: "local", path: c.path, writable: c.writable }
    : { id: c.id, kind: "remote", repo: c.repo, yamlPath: c.yamlPath, branch: c.branch, protected: c.protected, writable: c.writable };

/** A sandbox with the Python tool's dir holding `yaml`, linked from ~/.claude/skills/library. */
async function tool(yaml: string, { link = true } = {}) {
  const sb = await createSandbox();
  const dir = join(sb.root, "the-library-skill");
  await mkdir(dir);
  await writeFile(join(dir, "config.local.yaml"), yaml);
  if (link) {
    await mkdir(join(sb.host.paths.home, ".claude", "skills"), { recursive: true });
    await symlink(dir, join(sb.host.paths.home, ".claude", "skills", "library"));
  }
  return { ...sb, dir, file: join(dir, "config.local.yaml"), store: createConfigStore(sb.host) };
}

const plan = async (yaml: string) => {
  const { host } = await tool(yaml);
  const result = await planImport(host);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("planImport", () => {
  const valid = cases.filter((c) => c.catalogs && c.id !== "quoted-false-flags");

  it.each(valid.map((c) => [c.id, c] as const))("MIG-01: maps the CLI's normalized catalogs: %s", async (_, c) => {
    expect((await plan(c.yaml)).config.catalogs).toEqual(c.catalogs!.map(asConfig));
  });

  it.each(cases.filter((c) => c.problems.length > 0).map((c) => [c.id, c] as const))(
    "MIG-01: refuses an invalid registry with its problems: %s",
    async (_, c) => {
      const { host } = await tool(c.yaml);
      expect(await planImport(host)).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID", problems: c.problems } });
    },
  );

  it("MIG-01: reads quoted flags strictly, imports false and reports each coerced flag", async () => {
    const p = await plan(cases.find((c) => c.id === "quoted-false-flags")!.yaml);
    expect(p.config.catalogs).toMatchObject([{ id: "p", writable: false }, { id: "r", protected: false }]);
    expect(p.notImported).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^catalog 'p' writable: "false" is quoted/),
        expect.stringMatching(/^catalog 'r' protected: "false" is quoted/),
      ]),
    );
  });

  it("MIG-01: imports pins and reports the settings Loadout dropped", async () => {
    const p = await plan(cases.find((c) => c.id === "valid-all-flags")!.yaml);
    expect(p.config.pins).toEqual({ "session-retro": "personal" });
    expect(p.notImported).toEqual([
      "catalog 'personal' git_commit: not imported (Loadout never commits local catalogs)",
      "autopush: not imported (pull requests open only when you ask)",
      "default_add_catalog: not imported (Loadout asks which catalog when there is more than one)",
    ]);
  });

  it("MIG-03: reports default_dirs and unknown keys without importing them", async () => {
    const p = await plan(cases.find((c) => c.id === "valid-legacy-with-extras")!.yaml);
    expect(p.notImported).toEqual([
      "default_dirs: not imported (install locations are fixed)",
      "unknown_key: not imported (unknown setting)",
    ]);
    expect(p.config).not.toHaveProperty("default_dirs");
  });

  it("finds the tool dir through the library symlink, or takes one", async () => {
    const linked = await tool("catalog:\n  repo: r\n  yaml_path: y\n  branch: b\n");
    expect(await planImport(linked.host)).toMatchObject({ ok: true, value: { toolDir: await linked.host.fs.realPath(linked.dir) } });
    const unlinked = await tool("catalog:\n  repo: r\n  yaml_path: y\n  branch: b\n", { link: false });
    expect(await planImport(unlinked.host)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await planImport(unlinked.host, unlinked.dir)).toMatchObject({ ok: true, value: { toolDir: unlinked.dir } });
  });

  it("remembers the CLI's receipts only as a hint", async () => {
    const t = await tool("catalog:\n  repo: r\n  yaml_path: y\n  branch: b\n");
    const first = await planImport(t.host);
    expect(first.ok && first.value.installs).toBeUndefined();
    await writeFile(join(t.dir, ".installs.json"), "{}");
    const p = await planImport(t.host);
    expect(p).toMatchObject({ ok: true, value: { installs: join(await t.host.fs.realPath(t.dir), ".installs.json") } });
  });
});

describe("applyImport", () => {
  const yaml = "catalogs:\n  - id: personal\n    path: ~/dev/library.yaml\npins:\n  x: personal\n";

  it("MIG-01: writes config.json with imported, and never touches the old file", async () => {
    const t = await tool(yaml);
    await writeFile(join(t.dir, ".installs.json"), "{}");
    const before = await readFile(t.file);
    const p = await planImport(t.host);
    if (!p.ok) throw new Error(p.error.message);
    expect(await applyImport(t.host, t.store, p.value)).toMatchObject({ ok: true });
    const loaded = await t.store.loadConfig();
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        state: "ready",
        config: {
          catalogs: [{ id: "personal", kind: "local", path: "~/dev/library.yaml", writable: true }],
          pins: { x: "personal" },
          imported: { from: p.value.configFile, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), configSha256: p.value.configSha256, installs: p.value.installs },
        },
      },
    });
    expect(await readFile(t.file)).toEqual(before);
  });

  it("returns STALE_PLAN when the old file changed after the plan", async () => {
    const t = await tool(yaml);
    const p = await planImport(t.host);
    if (!p.ok) throw new Error(p.error.message);
    await writeFile(t.file, yaml + "# edited\n");
    expect(await applyImport(t.host, t.store, p.value)).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
  });

  it("refuses to replace catalogs that are already registered", async () => {
    const t = await tool(yaml);
    await t.store.saveConfig({ version: 1, catalogs: [{ id: "x", kind: "local", path: "/x" }], pins: {}, settings: {} });
    const p = await planImport(t.host);
    if (!p.ok) throw new Error(p.error.message);
    expect(await applyImport(t.host, t.store, p.value)).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });
});
