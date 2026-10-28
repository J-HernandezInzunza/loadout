import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { createSandbox, type Sandbox } from "../../test/sandbox.ts";
import type { AppConfigV1 } from "../config/config.ts";
import type { CatalogRef } from "../model/model.ts";
import { loadRegistry } from "./registry.ts";

const item = (name: string, extra = "") => `    - name: ${name}\n      description: ${name}\n      source: ./${name}\n${extra}`;
const catalog = (sections: Partial<Record<"skills" | "agents" | "prompts", string[]>>) =>
  "library:\n" + Object.entries(sections).map(([s, names]) => `  ${s}:\n${names.map((n) => item(n)).join("")}`).join("");

const config = (catalogs: CatalogRef[], pins: Record<string, string> = {}): AppConfigV1 => ({ version: 1, catalogs, pins, settings: {} });

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

/** A registry over local catalogs `id → text`, in the given order; `null` text means a missing file. */
async function registryOf(catalogs: [string, string | null][], pins: Record<string, string> = {}) {
  const sb = await createSandbox();
  const refs: CatalogRef[] = [];
  for (const [id, text] of catalogs) {
    const path = text === null ? join(sb.root, `${id}-missing.yaml`) : await file(sb, `${id}.yaml`, text);
    refs.push({ id, kind: "local", path });
  }
  return loadRegistry(sb.host, config(refs, pins));
}

const winner = (r: Awaited<ReturnType<typeof registryOf>>, name: string, catalog?: string) => {
  const result = r.resolve(name, catalog);
  return result.ok ? `${result.value.type}@${result.value.catalog}` : result.error.code;
};

describe("resolve", () => {
  it("RES-01: the first catalog in registry order wins", async () => {
    const r = await registryOf([["A", catalog({ skills: ["x"] })], ["B", catalog({ skills: ["x"] })]]);
    expect(winner(r, "x")).toBe("skill@A");
  });

  it("RES-02: a skill beats a prompt of the same name in one catalog (golden anchor-alias)", async () => {
    const text = loadGolden("read").cases.find((c) => c.id === "anchor-alias")!.text;
    const r = await registryOf([["A", text]]);
    expect(winner(r, "a")).toBe("skill@A");
  });

  it("RES-03: names match exactly, case included", async () => {
    const r = await registryOf([["A", catalog({ skills: ["Commit"] })]]);
    expect(winner(r, "commit")).not.toMatch(/@/);
    expect(winner(r, "Commit")).toBe("skill@A");
  });

  it("RES-04: no exact match returns candidates by name or description, AMBIGUOUS_NAME or NOT_FOUND", async () => {
    const r = await registryOf([
      ["A", "library:\n  skills:\n" + item("commit-and-push") + "    - name: lint\n      description: Runs the COMMIT hooks\n      source: ./l\n"],
    ]);
    expect(r.resolve("commit")).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "AMBIGUOUS_NAME",
        query: "commit",
        candidates: [
          { type: "skill", name: "commit-and-push", description: "commit-and-push", catalog: "A" },
          { type: "skill", name: "lint", description: "Runs the COMMIT hooks", catalog: "A" },
        ],
      }),
      warnings: [],
    });
    expect(r.resolve("zzz")).toMatchObject({ ok: false, error: { code: "NOT_FOUND", query: "zzz", candidates: [] } });
  });

  it("RES-05: resolves every name before returning any, failing on the first that does not resolve", async () => {
    const r = await registryOf([["A", catalog({ skills: ["a", "b"] })]]);
    expect(r.resolveAll(["a", "b"])).toMatchObject({ ok: true, value: [{ name: "a" }, { name: "b" }] });
    expect(r.resolveAll(["a", "c", "b"])).toMatchObject({ ok: false, error: { code: "NOT_FOUND", query: "c" } });
  });

  it("RES-06: a catalog searches only that catalog, ignoring pins and precedence", async () => {
    const r = await registryOf([["A", catalog({ skills: ["x"] })], ["B", catalog({ prompts: ["x"] })], ["C", catalog({ agents: ["x"] })]], { x: "C" });
    expect(winner(r, "x", "B")).toBe("prompt@B");
    expect(winner(r, "x")).toBe("agent@C");
  });

  it("RES-06: an unknown or skipped catalog is an error naming the active ones, never a fallback", async () => {
    const r = await registryOf([["A", catalog({ skills: ["x"] })], ["gone", null]]);
    for (const id of ["nope", "gone"]) {
      expect(r.resolve("x", id)).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_CATALOG", message: `unknown catalog '${id}' (available: A)` },
      });
    }
    const none = await registryOf([["gone", null]]);
    expect(none.resolve("x", "gone")).toMatchObject({ error: { message: "unknown catalog 'gone' (available: none)" } });
  });

  it("RES-10: a pin moves its catalog's copy to the front of that name's slots only", async () => {
    const r = await registryOf([["A", catalog({ skills: ["x", "y"] })], ["B", catalog({ skills: ["x", "y"] })]], { x: "B" });
    expect(winner(r, "x")).toBe("skill@B");
    expect(winner(r, "y")).toBe("skill@A");
    const entries = r.entries();
    expect(entries.ok && entries.value.map((e) => `${e.name}@${e.catalog}`)).toEqual(["x@B", "y@A", "x@A", "y@B"]);
    expect(r.winners().get("x")?.catalog).toBe("B");
  });

  it.each([
    ["unregistered", { x: "Z" }],
    ["skipped", { x: "gone" }],
    ["without the name", { x: "C" }],
  ])("RES-11: a pin to a catalog %s is inert", async (_, pins) => {
    const r = await registryOf([["A", catalog({ skills: ["x"] })], ["B", catalog({ skills: ["x"] })], ["C", catalog({})], ["gone", null]], pins);
    expect(winner(r, "x")).toBe("skill@A");
  });

  it("returns the registry's error when no catalog can be read", async () => {
    const r = await registryOf([["gone", null]]);
    expect(r.resolve("x")).toMatchObject({ ok: false, error: { code: "NO_READABLE_CATALOG" } });
  });
});
