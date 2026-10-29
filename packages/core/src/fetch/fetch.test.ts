import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createGitClient } from "../git/git.ts";
import { createOperation } from "../git/operation.ts";
import type { Entry } from "../model/model.ts";
import { fileManifest } from "../receipts/hash.ts";
import { destFor } from "../scan/scan.ts";
import { fetchEntry } from "./fetch.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const entry = (type: Entry["type"], name: string, source: string): Entry => ({
  type,
  name,
  description: name,
  source,
  requires: [],
  catalog: "team",
});

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const git = createGitClient(sb.host);
  const op = await createOperation(sb.host, git);
  const fetch = (e: Entry) => fetchEntry(sb.host, git, op, e);
  /** Every file under `dir`, relative, sorted. */
  const tree = async (dir: string) => ((await readdir(dir, { recursive: true, withFileTypes: true })).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(dir.length + 1))).sort();
  return { sb, h, git, op, fetch, tree, home: sb.host.paths.home };
}

const gh = (path: string) => `https://github.com/o/r/blob/main/${path}`;

describe("fetch: remote sources", () => {
  it("FETCH-05: records the commit and the oid of what was copied; a missing file is SOURCE_MISSING", async () => {
    const { h, fetch } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    const tip = remote.commit({ "skills/a/SKILL.md": "a\n", "prompts/p.md": "p\n" });
    const oid = (path: string) => h.git(["rev-parse", `${tip}:${path}`], { cwd: remote.path });

    expect(await fetch(entry("skill", "a", gh("skills/a/SKILL.md")))).toMatchObject({ ok: true, value: { commit: tip, sourceOid: oid("skills/a") } });
    expect(await fetch(entry("prompt", "p", gh("prompts/p.md")))).toMatchObject({ ok: true, value: { commit: tip, sourceOid: oid("prompts/p.md") } });
    expect(await fetch(entry("prompt", "q", gh("prompts/q.md")))).toEqual({
      ok: false,
      error: { code: "SOURCE_MISSING", message: "referenced file missing in repo: prompts/q.md" },
      warnings: [],
    });
  });

  it("FETCH-06: a skill stages its whole folder; an agent or prompt stages one file named after the entry", async () => {
    const { sb, h, fetch, tree } = await setup();
    h.createRepo("github.com", "o/r").commit({
      "skills/a/SKILL.md": "a\n",
      "skills/a/references/deep/x.md": "x\n",
      "skills/b/SKILL.md": "b\n",
      "agents/helper-v2.md": "agent\n",
    });

    const skill = await fetch(entry("skill", "review", gh("skills/a/SKILL.md")));
    expect(skill.ok && skill.value.staged.endsWith("/review")).toBe(true);
    if (!skill.ok) return;
    expect(await tree(skill.value.staged)).toEqual(["SKILL.md", "references/deep/x.md"]);
    expect(skill.value.files).toEqual(await fileManifest(sb.host, skill.value.staged));

    const agent = await fetch(entry("agent", "helper", gh("agents/helper-v2.md")));
    expect(agent.ok && agent.value.staged.endsWith("/helper.md")).toBe(true);
    expect(agent.ok && (await readFile(agent.value.staged, "utf8"))).toBe("agent\n");
    expect(agent.ok && Object.keys(agent.value.files)).toEqual(["helper.md"]);
  });

  it("FETCH-10 (rebuild): a skill at the repo root stages without .git", async () => {
    const { h, fetch, tree } = await setup();
    h.createRepo("github.com", "o/r").commit({ "SKILL.md": "root\n", "scripts/run.sh": "echo\n" });
    const res = await fetch(entry("skill", "rooted", gh("SKILL.md")));
    expect(res.ok && (await tree(res.value.staged))).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it("FETCH-11: a folder source stages its parent folder", async () => {
    const { h, fetch, tree } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/a/assets/logo.txt": "l\n" });
    const res = await fetch(entry("skill", "a", gh("skills/a/assets")));
    expect(res.ok && (await tree(res.value.staged))).toEqual(["SKILL.md", "assets/logo.txt"]);
  });

  it("FETCH-12 (rebuild): a skill folder without SKILL.md fails verification", async () => {
    const { h, fetch } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/README.md": "no skill here\n", "skills/a/SKILL.md": "a\n" });
    // A folder source stages its parent, `skills/`, which has no SKILL.md of its own.
    expect(await fetch(entry("skill", "a", gh("skills/a")))).toMatchObject({ ok: false, error: { code: "VERIFY_FAILED", message: expect.stringContaining("no SKILL.md") } });
  });

  it("FETCH-04: entries from one repo+branch share the operation's checkout", async () => {
    const { sb, h, fetch } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/b/SKILL.md": "b\n" });
    await fetch(entry("skill", "a", gh("skills/a/SKILL.md")));
    await fetch(entry("skill", "b", gh("skills/b/SKILL.md")));
    const clones = sb.audit.filter((e) => e.kind === "proc:start" && e.argv.includes("clone"));
    expect(clones).toHaveLength(2); // ssh refused, https once
  });
});

describe("fetch: local sources", () => {
  it("FETCH-07: copies from this machine, with no commit or oid; a missing path is SOURCE_MISSING", async () => {
    const { sb, fetch, tree } = await setup();
    const src = join(sb.root, "work/skills/a");
    await put(join(src, "SKILL.md"), "a\n");
    await put(join(src, "notes/n.md"), "n\n");

    const res = await fetch(entry("skill", "a", join(src, "SKILL.md")));
    expect(res).toMatchObject({ ok: true, value: { commit: null, sourceOid: null } });
    expect(res.ok && (await tree(res.value.staged))).toEqual(["SKILL.md", "notes/n.md"]);
    expect(await fetch(entry("prompt", "gone", join(sb.root, "gone.md")))).toEqual({
      ok: false,
      error: { code: "SOURCE_MISSING", message: `local source not found: ${join(sb.root, "gone.md")}` },
      warnings: [],
    });
  });

  it("FETCH-07: expands ~ against the host's home", async () => {
    const { home, fetch } = await setup();
    await put(join(home, "lib/prompts/p.md"), "p\n");
    expect(await fetch(entry("prompt", "p", "~/lib/prompts/p.md"))).toMatchObject({ ok: true });
  });

  it("FETCH-08: refuses a source that overlaps its destination, either way round, through symlinks too", async () => {
    const { sb, home, fetch } = await setup();
    const dest = destFor(home, "skill", "a");
    await put(join(dest, "SKILL.md"), "installed\n");
    // Source at the destination.
    expect(await fetch(entry("skill", "a", join(dest, "SKILL.md")))).toMatchObject({ ok: false, error: { code: "REFUSED", message: expect.stringContaining("the source is the destination") } });
    // Source folder holding the destination.
    await put(join(home, ".claude/SKILL.md"));
    expect(await fetch(entry("skill", "a", join(home, ".claude/SKILL.md")))).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    // The same, reached through a symlink.
    await symlink(dest, join(sb.root, "alias"));
    expect(await fetch(entry("skill", "a", join(sb.root, "alias/SKILL.md")))).toMatchObject({ ok: false, error: { code: "REFUSED" } });
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("installed\n");
  });

  it("refuses an agent or prompt whose source is a folder, and an unparseable source", async () => {
    const { sb, fetch } = await setup();
    await mkdir(join(sb.root, "prompts"), { recursive: true });
    expect(await fetch(entry("prompt", "p", join(sb.root, "prompts")))).toMatchObject({ ok: false, error: { code: "VERIFY_FAILED" } });
    expect(await fetch(entry("prompt", "p", "ftp://x"))).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE" } });
  });
});

describe("fetch: staging", () => {
  it("stages inside the operation's dir, so dispose() removes it, and never writes to an install dir", async () => {
    const { sb, home, op, fetch } = await setup();
    await put(join(sb.root, "p.md"), "p\n");
    const res = await fetch(entry("prompt", "p", join(sb.root, "p.md")));
    expect(res.ok && res.value.staged.startsWith(op.dir + "/")).toBe(true);
    expect(await sb.host.fs.exists(join(home, ".claude"))).toBe(false);
    await op.dispose();
    expect(res.ok && (await sb.host.fs.exists(res.value.staged))).toBe(false);
  });
});
