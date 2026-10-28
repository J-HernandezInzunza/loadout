import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import type { CatalogRef } from "../model/model.ts";
import { loadRegistry } from "../registry/registry.ts";
import { writeTarget } from "./target.ts";

const yaml = (...names: string[]) =>
  "library:\n  skills:\n" + names.map((n) => `    - name: ${n}\n      description: d\n      source: /s/${n}/SKILL.md\n`).join("");

/** Catalogs as [id, yaml or null for an unreadable one, writable]. */
async function registryOf(catalogs: [string, string | null, boolean?][], pins: Record<string, string> = {}) {
  const sb = await createSandbox();
  const refs: CatalogRef[] = [];
  for (const [id, text, writable] of catalogs) {
    const path = join(sb.root, `${id}.yaml`);
    if (text !== null) {
      await mkdir(sb.root, { recursive: true });
      await writeFile(path, text);
    }
    refs.push({ id, kind: "local", path, ...(writable === false && { writable: false }) });
  }
  return loadRegistry(sb.host, { version: 1, catalogs: refs, pins, settings: {} });
}

const id = (r: ReturnType<typeof writeTarget>) => (r.ok ? r.value.catalog.ref.id : r.error.code);

describe("writeTarget: add", () => {
  it("WRITE-01: a named catalog must be active and writable", async () => {
    const r = await registryOf([["mine", yaml()], ["team", yaml(), false], ["gone", null]]);
    expect(id(writeTarget(r, { op: "add", catalog: "mine" }))).toBe("mine");
    expect(writeTarget(r, { op: "add", catalog: "team" })).toMatchObject({ ok: false, error: { code: "READ_ONLY", message: "catalog 'team' is read-only (writable: false)" } });
    expect(writeTarget(r, { op: "add", catalog: "gone" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_CATALOG", message: "unknown catalog 'gone' (available: mine, team)" } });
    expect(writeTarget(r, { op: "add", catalog: "nope" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_CATALOG" } });
  });

  it("WRITE-02 (rebuild): no writable catalog, exactly one, or more than one", async () => {
    expect(writeTarget(await registryOf([["team", yaml(), false]]), { op: "add" })).toMatchObject({
      ok: false,
      error: { code: "NO_WRITABLE_CATALOG", message: "no writable catalog is configured; nothing can be written" },
    });
    expect(id(writeTarget(await registryOf([["mine", yaml()], ["team", yaml(), false], ["gone", null]]), { op: "add" }))).toBe("mine");
  });

  it("WRITE-03: several writable catalogs are a typed decision naming the choices", async () => {
    const r = await registryOf([["mine", yaml()], ["team", yaml()]]);
    expect(writeTarget(r, { op: "add" })).toEqual({
      ok: false,
      error: { code: "AMBIGUOUS_CATALOG", message: "a new entry could go to 'mine' or 'team'; choose a catalog", catalogs: ["mine", "team"] },
      warnings: [],
    });
  });
});

describe("writeTarget: update and remove", () => {
  it("WRITE-04: goes to the catalog the entry resolved from", async () => {
    const r = await registryOf([["mine", yaml("a")], ["team", yaml("b")]]);
    expect(writeTarget(r, { op: "update", name: "b" })).toMatchObject({ ok: true, value: { catalog: { ref: { id: "team" } }, entry: { name: "b", catalog: "team" } } });
  });

  it("WRITE-04: a name held by several catalogs is AMBIGUOUS_CATALOG with the holders in resolution order, even when pinned", async () => {
    const r = await registryOf([["mine", yaml("x")], ["team", yaml("x")]], { x: "team" });
    expect(writeTarget(r, { op: "remove", name: "x" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_CATALOG", catalogs: ["mine", "team"] } });
    expect(writeTarget(r, { op: "remove", name: "x", catalog: "team" })).toMatchObject({ ok: true, value: { entry: { catalog: "team" } } });
  });

  it("WRITE-04: a named catalog must hold the entry; an unknown name gets suggestions; a read-only holder refuses", async () => {
    const r = await registryOf([["mine", yaml("review")], ["team", yaml("deploy"), false]]);
    expect(writeTarget(r, { op: "update", name: "review", catalog: "team" })).toMatchObject({ ok: false, error: { code: "READ_ONLY" } });
    expect(writeTarget(r, { op: "update", name: "deploy", catalog: "mine" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "'deploy' is not in catalog 'mine' (it is in: team)" },
    });
    expect(writeTarget(r, { op: "update", name: "revie" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "no entry named 'revie' (did you mean: review?)" } });
    expect(writeTarget(r, { op: "update", name: "deploy" })).toMatchObject({ ok: false, error: { code: "READ_ONLY" } });
  });

  it("narrows by type when given one", async () => {
    const both = "library:\n  skills:\n    - name: x\n      description: d\n      source: /s\n  prompts:\n    - name: x\n      description: d\n      source: /p\n";
    const r = await registryOf([["mine", both]]);
    expect(writeTarget(r, { op: "remove", name: "x", type: "prompt" })).toMatchObject({ ok: true, value: { entry: { type: "prompt" } } });
  });
});
