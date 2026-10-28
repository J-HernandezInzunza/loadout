import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import type { CatalogRef } from "../model/model.ts";
import { createLibrary } from "./library.ts";
import { ops } from "./schemas.ts";

const A = `library:
  skills:
    - name: commit-and-push
      description: Commit staged changes and push
      source: https://github.com/org/repo/blob/main/skills/commit/SKILL.md
      requires: ["prompt:commit-style", "skill:missing"]
    - name: lint
      description: Runs the COMMIT hooks
      source: ~/skills/lint/SKILL.md
  prompts:
    - name: commit-style
      description: House style
      source: not a source
`;
const B = `library:
  skills:
    - name: commit-and-push
      description: B's copy
      source: ./b
`;

async function setup(extra: CatalogRef[] = []) {
  const sb = await createSandbox();
  const write = async (name: string, text: string) => {
    const path = join(sb.root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
    return path;
  };
  const catalogs: CatalogRef[] = [
    { id: "A", kind: "local", path: await write("a.yaml", A) },
    { id: "B", kind: "local", path: await write("b.yaml", B), writable: false },
    ...extra,
  ];
  await createConfigStore(sb.host).saveConfig({ version: 1, catalogs, pins: {}, settings: {} });
  return { sb, library: createLibrary(sb.host) };
}

describe("createLibrary", () => {
  it("shares no state between two instances", async () => {
    const one = await setup();
    const other = await createSandbox();
    await createConfigStore(other.host).saveConfig({ version: 1, catalogs: [], pins: {}, settings: {} });
    const listed = await one.library.list();
    expect(listed.ok && listed.value).toHaveLength(4);
    expect(await createLibrary(other.host).list()).toEqual({ ok: true, value: [], warnings: [] });
  });

  it("list returns every copy in resolution order, matching its schema", async () => {
    const { library } = await setup();
    const list = await library.list();
    if (!list.ok) throw new Error(list.error.message);
    expect(list.value.map((r) => `${r.name}@${r.catalog}:${r.overriddenBy ?? "-"}`)).toEqual([
      "commit-and-push@A:-",
      "lint@A:-",
      "commit-style@A:-",
      "commit-and-push@B:A",
    ]);
    expect(ops.list.output.parse(list.value)).toEqual(list.value);
  });

  it("catalogs reports catalog-level fields, skipped ones included, offline", async () => {
    const { sb, library } = await setup([{ id: "team", kind: "remote", repo: "git@x:o/r.git", yamlPath: "library.yaml", branch: "main", protected: true }]);
    const rows = await library.catalogs();
    if (!rows.ok) throw new Error(rows.error.message);
    expect(rows.value).toEqual([
      { precedence: 1, id: "A", kind: "local", location: join(sb.root, "a.yaml"), writeMode: "local", writable: true, entries: 3, skipped: null },
      { precedence: 2, id: "B", kind: "local", location: join(sb.root, "b.yaml"), writeMode: "local", writable: false, entries: 1, skipped: null },
      {
        precedence: 3,
        id: "team",
        kind: "remote",
        location: "git@x:o/r.git (main, library.yaml)",
        writeMode: "pr",
        writable: true,
        entries: null,
        skipped: `not cloned yet at ${join(sb.host.paths.appData, "clones", "team")}`,
      },
    ]);
    expect(ops.catalogs.output.parse(rows.value)).toEqual(rows.value);
    expect(sb.audit.some((e) => e.kind.startsWith("proc"))).toBe(false);
  });

  it("search matches name or description case-insensitively, overridden copies included", async () => {
    const { library } = await setup();
    const found = await library.search("COMMIT");
    expect(found.ok && found.value.map((r) => `${r.name}@${r.catalog}`)).toEqual([
      "commit-and-push@A",
      "lint@A",
      "commit-style@A",
      "commit-and-push@B",
    ]);
    expect(await library.search("nothing like it")).toMatchObject({ ok: true, value: [] });
  });

  it("RES-04: show of an unknown name returns NOT_FOUND or AMBIGUOUS_NAME with candidates", async () => {
    const { library } = await setup();
    expect(await library.show("zzz")).toMatchObject({ ok: false, error: { code: "NOT_FOUND", candidates: [] } });
    expect(await library.show("commit")).toMatchObject({
      ok: false,
      error: { code: "AMBIGUOUS_NAME", candidates: [{ name: "commit-and-push" }, { name: "lint" }, { name: "commit-style" }, { name: "commit-and-push" }] },
    });
  });

  it("show reports copies, dependencies, dependents and the parsed source of the subject", async () => {
    const { sb, library } = await setup();
    const shown = await library.show("commit-and-push");
    if (!shown.ok) throw new Error(shown.error.message);
    expect(shown.value).toMatchObject({
      name: "commit-and-push",
      entry: { catalog: "A", overrides: ["B"] },
      copies: [{ catalog: "A", wins: true, subject: true }, { catalog: "B", wins: false, subject: false }],
      requires: [{ type: "prompt", name: "commit-style", catalog: "A", description: "House style" }],
      unresolvedRequires: [{ ref: "skill:missing", requiredBy: "commit-and-push", reason: "not_found" }],
      dependents: [],
      source: { raw: "https://github.com/org/repo/blob/main/skills/commit/SKILL.md", kind: "github", cloneUrls: expect.any(Array) },
    });
    expect(ops.show.output.parse(shown.value)).toEqual(shown.value);

    const style = await library.show("commit-style");
    expect(style.ok && style.value.dependents).toEqual([
      { type: "skill", name: "commit-and-push", catalog: "A", description: "Commit staged changes and push", direct: true },
    ]);
    expect(style.ok && style.value.source).toEqual({ raw: "not a source", kind: "unknown", error: "unrecognized source format: not a source" });
    const lint = await library.show("lint");
    expect(lint.ok && lint.value.source).toEqual({ raw: "~/skills/lint/SKILL.md", kind: "local", path: join(sb.host.paths.home, "skills/lint/SKILL.md") });
  });

  it("show of another catalog's copy reports that copy as the subject", async () => {
    const { library } = await setup();
    const shown = await library.show("commit-and-push", { catalog: "B" });
    expect(shown).toMatchObject({
      ok: true,
      value: { entry: { catalog: "B", overriddenBy: "A" }, copies: [{ subject: false }, { subject: true }] },
    });
  });

  it("UPD-07: search and show never compute staleness or reach the network", async () => {
    const { sb, library } = await setup();
    const found = await library.search("commit");
    const shown = await library.show("lint");
    expect(found.ok && found.value.map((r) => r.state)).not.toContain("stale");
    expect(shown.ok && [shown.value.entry.state]).not.toContain("stale");
    expect(sb.audit.some((e) => e.kind.startsWith("proc"))).toBe(false);
  });

  it("validates each op's input", () => {
    expect(ops.show.input.safeParse({ name: "x", catalog: "A" }).success).toBe(true);
    expect(ops.show.input.safeParse({}).success).toBe(false);
    expect(ops.search.input.safeParse({ query: "x" }).success).toBe(true);
    expect(ops.list.input.safeParse({ catalog: 3 }).success).toBe(false);
    expect(ops.catalogs.input.safeParse({}).success).toBe(true);
  });
});
