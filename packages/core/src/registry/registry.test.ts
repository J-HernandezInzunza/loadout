import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox, type Sandbox } from "../../test/sandbox.ts";
import type { AppConfigV1 } from "../config/config.ts";
import type { CatalogRef } from "../model/model.ts";
import { loadRegistry } from "./registry.ts";

const item = (name: string, extra = "") => `    - name: ${name}\n      description: ${name}\n      source: ./${name}\n${extra}`;
const catalog = (sections: Partial<Record<"skills" | "agents" | "prompts", string[]>>) =>
  "library:\n" + Object.entries(sections).map(([s, names]) => `  ${s}:\n${names.map((n) => item(n)).join("")}`).join("");

const config = (catalogs: CatalogRef[]): AppConfigV1 => ({ version: 1, catalogs, pins: {}, settings: {} });

async function file(sb: Sandbox, rel: string, text: string) {
  const path = join(sb.root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("loadRegistry", () => {
  it("RCAT-02: skips a remote catalog whose clone does not exist, without cloning", async () => {
    const sb = await createSandbox();
    const remote: CatalogRef = { id: "team", kind: "remote", repo: "git@github.com:o/r.git", yamlPath: "lib/library.yaml", branch: "main", protected: true };
    const registry = await loadRegistry(sb.host, config([remote]));
    const clone = join(sb.host.paths.appData, "clones", "team");
    expect(registry.catalogs()).toMatchObject([{ ref: { id: "team" }, skipped: `not cloned yet at ${clone}` }]);
    expect(sb.audit.filter((e) => e.kind !== "fs")).toEqual([]);

    await file(sb, "appData/clones/team/lib/library.yaml", catalog({ skills: ["a"] }));
    const cloned = await loadRegistry(sb.host, config([remote]));
    expect(cloned.catalogs()[0]!.skipped).toBeUndefined();
    expect(cloned.entriesOf("team").map((e) => e.name)).toEqual(["a"]);
  });

  it("RCAT-08: skips one unreadable catalog of several with a warning; the others serve", async () => {
    const sb = await createSandbox();
    const ok = await file(sb, "ok.yaml", catalog({ skills: ["a"] }));
    const missing = join(sb.root, "missing.yaml");
    const registry = await loadRegistry(sb.host, config([{ id: "gone", kind: "local", path: missing }, { id: "ok", kind: "local", path: ok }]));
    expect(registry.entries()).toEqual({
      ok: true,
      value: [expect.objectContaining({ name: "a", catalog: "ok" })],
      warnings: [{ message: `catalog 'gone' skipped: not found at ${missing}` }],
    });
    expect(registry.active().map((c) => c.ref.id)).toEqual(["ok"]);
  });

  it("RCAT-08: a single unreadable catalog fails with its reason", async () => {
    const sb = await createSandbox();
    const missing = join(sb.root, "missing.yaml");
    const registry = await loadRegistry(sb.host, config([{ id: "gone", kind: "local", path: missing }]));
    expect(registry.entries()).toEqual({ ok: false, error: { code: "NO_READABLE_CATALOG", message: `not found at ${missing}` }, warnings: [] });
  });

  it("RCAT-08: several catalogs all unreadable fail with every reason", async () => {
    const sb = await createSandbox();
    const broken = await file(sb, "broken.yaml", "library:\n\tskills: []\n");
    const missing = join(sb.root, "missing.yaml");
    const registry = await loadRegistry(sb.host, config([{ id: "a", kind: "local", path: missing }, { id: "b", kind: "local", path: broken }]));
    const result = registry.entries();
    expect(result).toMatchObject({ ok: false, error: { code: "NO_READABLE_CATALOG" } });
    expect(!result.ok && result.error.message).toMatch(
      new RegExp(`^no readable catalog: a \\(not found at ${missing}\\); b \\(can't parse ${broken}: .+ \\(line 2\\)\\)$`),
    );
  });

  it("RCAT-09: lists every catalog with its skip reason and never runs a process", async () => {
    const sb = await createSandbox();
    const ok = await file(sb, "ok.yaml", catalog({ skills: ["a"] }));
    const registry = await loadRegistry(
      sb.host,
      config([
        { id: "ok", kind: "local", path: ok },
        { id: "team", kind: "remote", repo: "r", yamlPath: "library.yaml", branch: "main", protected: false },
      ]),
    );
    expect(registry.catalogs().map((c) => [c.ref.id, c.skipped])).toEqual([
      ["ok", undefined],
      ["team", `not cloned yet at ${join(sb.host.paths.appData, "clones", "team")}`],
    ]);
    expect(sb.audit.some((e) => e.kind.startsWith("proc"))).toBe(false);
  });

  it("RES-18: keys winners by name only, first catalog in precedence order wins", async () => {
    const sb = await createSandbox();
    const first = await file(sb, "first.yaml", catalog({ prompts: ["x"] }));
    const second = await file(sb, "second.yaml", catalog({ skills: ["x", "y"] }));
    const registry = await loadRegistry(sb.host, config([{ id: "first", kind: "local", path: first }, { id: "second", kind: "local", path: second }]));
    expect([...registry.winners()].map(([name, e]) => [name, e.type, e.catalog])).toEqual([
      ["x", "prompt", "first"],
      ["y", "skill", "second"],
    ]);
  });

  it("reads a local path given as ~ or as a directory holding library.yaml", async () => {
    const sb = await createSandbox();
    await file(sb, "home/cat/library.yaml", catalog({ agents: ["r"] }));
    const registry = await loadRegistry(sb.host, config([{ id: "mine", kind: "local", path: "~/cat" }]));
    expect(registry.entriesOf("mine")).toMatchObject([{ type: "agent", name: "r", catalog: "mine" }]);
  });

  it("keeps a catalog's entry problems without skipping it", async () => {
    const sb = await createSandbox();
    const path = await file(sb, "c.yaml", "library:\n  skills:\n    - name: yes\n" + item("ok"));
    const registry = await loadRegistry(sb.host, config([{ id: "c", kind: "local", path }]));
    expect(registry.catalogs()[0]!.skipped).toBeUndefined();
    expect(registry.catalogs()[0]).toMatchObject({ problems: [{ path: "skills[0].name" }] });
    expect(registry.entriesOf("c").map((e) => e.name)).toEqual(["ok"]);
  });

  it("counts only active catalogs marked writable as writable", async () => {
    const sb = await createSandbox();
    const a = await file(sb, "a.yaml", catalog({}));
    const registry = await loadRegistry(
      sb.host,
      config([
        { id: "a", kind: "local", path: a },
        { id: "ro", kind: "local", path: a, writable: false },
        { id: "gone", kind: "local", path: join(sb.root, "nope.yaml") },
      ]),
    );
    expect(registry.writable().map((c) => c.ref.id)).toEqual(["a"]);
  });
});
