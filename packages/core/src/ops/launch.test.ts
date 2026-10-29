import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checked } from "../../test/checkedLibrary.ts";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef } from "../model/model.ts";
import { createLibrary } from "./library.ts";
import { ops } from "./schemas.ts";

const remote = (id: string, slug: string): CatalogRef => ({
  id,
  kind: "remote",
  repo: `https://github.com/${slug}.git`,
  branch: "main",
  yamlPath: "library.yaml",
  protected: false,
});

async function setup(catalogs: CatalogRef[]) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  if (catalogs.length > 0) await createConfigStore(sb.host).saveConfig({ version: 1, catalogs, pins: {}, settings: {} });
  const library = checked(createLibrary(sb.host, { git: createGitClient(sb.host) }));
  return { sb, h, library, tmp: join(sb.host.paths.appData, "tmp") };
}

describe("launch", () => {
  it("removes what a killed operation left in tmp, then clones the remote catalogs", async () => {
    const { sb, h, library, tmp } = await setup([remote("team", "o/cat")]);
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": "library:\n  skills:\n  agents:\n  prompts:\n" });
    await mkdir(join(tmp, "op-killed/clone"), { recursive: true });
    await writeFile(join(tmp, "op-killed/clone/file"), "x\n");

    const launched = await library.launch();
    expect(launched).toEqual({ ok: true, value: { state: "ready", catalogs: [{ id: "team", outcome: "cloned" }] }, warnings: [] });
    expect(ops.launch.output.safeParse(launched.ok && launched.value).success).toBe(true);
    expect(await sb.host.fs.exists(join(tmp, "op-killed"))).toBe(false);
    expect(await sb.host.fs.exists(join(sb.host.paths.appData, "clones/team/library.yaml"))).toBe(true);
  });

  it("offline, a catalog that can't be reached is a warning, not an error", async () => {
    const { library } = await setup([remote("team", "o/unreachable")]);
    const launched = await library.launch();
    expect(launched).toMatchObject({ ok: true, value: { state: "ready", catalogs: [{ id: "team", outcome: "skipped" }] } });
    expect(launched.warnings).toEqual([expect.objectContaining({ message: expect.stringContaining("team") })]);
  });

  it("reports the no-catalogs state when nothing is registered", async () => {
    const { library } = await setup([]);
    expect(await library.launch()).toEqual({ ok: true, value: { state: "no-catalogs", catalogs: [] }, warnings: [] });
  });
});
