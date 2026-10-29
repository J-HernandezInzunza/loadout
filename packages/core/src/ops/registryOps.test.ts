import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createGitHarness } from "../../test/git.ts";
import { checked } from "../../test/checkedLibrary.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef, CoreError, Result } from "../model/model.ts";
import { createLibrary } from "./library.ts";
import { ops } from "./schemas.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const catalogText = (...names: string[]) =>
  `library:\n  skills:\n${names.map((n) => `    - name: ${n}\n      description: ${n}\n      source: ~/src/${n}/SKILL.md\n`).join("")}  agents:\n  prompts:\n`;

async function setup(catalogs: Record<string, string[]> = { A: ["x", "y"], B: ["x"] }, pins: Record<string, string> = {}, extra: CatalogRef[] = []) {
  const sb = await createSandbox();
  const stub = await createApiStub();
  const refs: CatalogRef[] = [];
  for (const [id, names] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, catalogText(...names));
    refs.push({ id, kind: "local", path });
  }
  if (refs.length + extra.length > 0) {
    await createConfigStore(sb.host).saveConfig({ version: 1, catalogs: [...refs, ...extra], pins, settings: {} });
  }
  const library = checked(createLibrary(sb.host, {
    git: createGitClient(sb.host),
    apiBases: stub.bases,
    managedSettingsFile: join(sb.root, "managed-settings.json"),
    githubClientId: "gh-client",
  }));
  return { sb, stub, library, configFile: join(sb.host.paths.appData, "config.json") };
}

/** The op's value, checked against the op's output schema. */
function value<T, E extends CoreError>(r: Result<T, E>, schema: { safeParse(v: unknown): { success: boolean } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expect(schema.safeParse(r.value).success).toBe(true);
  return r.value;
}

describe("facade: registry, accounts and maintenance", () => {
  it("pins lists every pin by name; RES-11: a pin to an unregistered catalog or one lacking the name is dangling and inert", async () => {
    const { library } = await setup({ A: ["x", "y"], B: ["x"] }, { x: "B", y: "B", z: "gone" });
    expect(value(await library.pins(), ops.pins.output)).toEqual([
      { name: "x", catalog: "B", holders: ["A", "B"], dangling: false, resolvesTo: "B" },
      { name: "y", catalog: "B", holders: ["A"], dangling: true, resolvesTo: "A" },
      { name: "z", catalog: "gone", holders: [], dangling: true, resolvesTo: null },
    ]);
  });

  it("doctor reports findings in its schema", async () => {
    const { library } = await setup({ A: ["x"] });
    const report = value(await library.doctor({ noPull: true }), ops.doctor.output);
    // x's local source doesn't exist, so the report has at least that problem.
    expect(report.status).toBe("problems");
    expect(report.entries).toBe(1);
  });

  it("recloneCatalog replaces a remote catalog's clone; an unknown id is UNKNOWN_CATALOG", async () => {
    const remote: CatalogRef = { id: "team", kind: "remote", repo: "https://github.com/o/cat.git", branch: "main", yamlPath: "library.yaml", protected: false };
    const { sb, library } = await setup({ A: ["x"] }, {}, [remote]);
    createGitHarness(sb).createRepo("github.com", "o/cat").commit({ "library.yaml": catalogText("t") });
    value(await library.recloneCatalog("team"), ops.recloneCatalog.output);
    expect(await sb.host.fs.exists(join(sb.host.paths.appData, "clones/team/library.yaml"))).toBe(true);
    expect(await library.recloneCatalog("nope")).toMatchObject({ ok: false, error: { code: "UNKNOWN_CATALOG" } });
  });

  it("planAddCatalog/applyAddCatalog register a working catalog; a file that isn't a catalog is REFUSED", async () => {
    const { sb, library } = await setup({ A: ["x"] });
    const path = join(sb.root, "new.yaml");
    await put(path, catalogText("n"));
    const plan = value(await library.planAddCatalog({ kind: "local", id: "new", path, position: "first" }), ops.planAddCatalog.output);
    const registered = value(await library.applyAddCatalog(plan), ops.applyAddCatalog.output);
    expect(registered.map((c) => c.id)).toEqual(["new", "A"]);

    await put(join(sb.root, "junk.yaml"), "just: text\n");
    expect(await library.planAddCatalog({ kind: "local", id: "junk", path: join(sb.root, "junk.yaml") })).toMatchObject({
      ok: false,
      error: { code: "REFUSED" },
    });
  });

  it("initCatalog scaffolds and registers a catalog; an existing file is DUPLICATE", async () => {
    const { sb, library } = await setup({ A: ["x"] });
    const made = value(await library.initCatalog({ path: join(sb.root, "mine"), id: "mine" }), ops.initCatalog.output);
    expect(made.created).toBe(join(sb.root, "mine/library.yaml"));
    expect(made.catalogs.map((c) => c.id)).toEqual(["mine", "A"]);
    expect(await library.initCatalog({ path: join(sb.root, "mine"), id: "again" })).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
  });

  it("removeCatalog unregisters a catalog; the only catalog is REFUSED", async () => {
    const { library } = await setup({ A: ["x"], B: ["x"] });
    value(await library.removeCatalog({ id: "B" }), ops.removeCatalog.output);
    expect(value(await library.catalogs(), ops.catalogs.output).map((c) => c.id)).toEqual(["A"]);
    expect(await library.removeCatalog({ id: "A" })).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("planImport/applyImport bring in the Python CLI's registry; importing over registered catalogs is REFUSED", async () => {
    const { sb, library } = await setup({});
    const dir = join(sb.root, "the-library-skill");
    await put(join(dir, "config.local.yaml"), `catalogs:\n  - id: mine\n    path: ${join(sb.root, "mine.yaml")}\npins:\n  x: mine\n`);
    await mkdir(join(sb.host.paths.home, ".claude/skills"), { recursive: true });
    await symlink(dir, join(sb.host.paths.home, ".claude/skills/library"));

    const plan = value(await library.planImport(), ops.planImport.output);
    expect(value(await library.applyImport(plan), ops.applyImport.output)).toEqual({ catalogs: 1, pins: 1, notImported: [] });
    expect(await library.applyImport(plan)).toMatchObject({ ok: false, error: { code: "REFUSED" } });
  });

  it("connect, accounts and disconnect go through the instance's accounts; a rejected token is AUTH_FAILED", async () => {
    const { sb, stub, library, configFile } = await setup({ A: ["x"] });
    stub.addToken("github", "gh-token", "octo", ["repo"]);
    expect(value(await library.connect("github", { accessToken: "gh-token" }), ops.connect.output)).toMatchObject({ login: "octo" });
    expect(value(await library.accounts(), ops.accounts.output)).toMatchObject({ github: { login: "octo", scopes: ["repo"] } });
    expect(await readFile(configFile, "utf8")).not.toContain("gh-token");
    expect(await library.connect("bitbucket", { accessToken: "wrong" })).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });

    value(await library.disconnect("github"), ops.disconnect.output);
    expect(value(await library.accounts(), ops.accounts.output)).toEqual({});
    expect(await sb.host.secrets.get("github")).toBeNull();
  });

  it("beginSignIn/completeSignIn connect a GitHub account through the device flow; Bitbucket isn't available yet", async () => {
    const { stub, library } = await setup({ A: ["x"] });
    const started = value(await library.beginSignIn("github"), ops.beginSignIn.output);
    expect(started).toMatchObject({ on: "github", userCode: "CODE-0001", verificationUri: "https://github.com/login/device" });
    stub.approveDevice("CODE-0001", "octo");
    expect(value(await library.completeSignIn(started), ops.completeSignIn.output)).toMatchObject({ login: "octo" });
    expect(value(await library.accounts(), ops.accounts.output)).toMatchObject({ github: { login: "octo" } });
    expect(await library.beginSignIn("bitbucket")).toMatchObject({ ok: false, error: { code: "SIGN_IN_UNAVAILABLE" } });
  });
});
