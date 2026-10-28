import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { catalogStatus } from "../catalogs/catalogs.ts";
import { createGitClient, pushError } from "../git/git.ts";
import type { Host } from "../host.ts";
import type { CatalogRef } from "../model/model.ts";
import { loadRegistry } from "../registry/registry.ts";
import { editCopy } from "./copy.ts";
import { applyDirectWrite, planDirectWrite } from "./direct.ts";

const catalog = "library:\n  skills:\n    - name: a\n      description: A\n      source: https://github.com/o/s/blob/main/a/SKILL.md\n  agents: []\n  prompts: []\n";
const entry = { type: "skill" as const, name: "b", description: "B", source: "https://github.com/o/s/blob/main/b/SKILL.md", requires: [] };
const ref: CatalogRef = { id: "team", kind: "remote", repo: "https://github.com/o/cat.git", yamlPath: "library.yaml", branch: "main", protected: false };

async function setup(wrap: (h: Host) => Host = (h) => h) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  const h = createGitHarness(sb);
  const repo = h.createRepo("github.com", "o/cat");
  repo.commit({ "library.yaml": catalog });
  const ctx = { host, git: createGitClient(host) };
  const state = async () => (await loadRegistry(host, { version: 1, catalogs: [ref], pins: {}, settings: {} })).catalogs()[0]!;
  const write = async (edit: Parameters<typeof planDirectWrite>[2], opts: { dryRun?: boolean } = {}) => {
    const plan = await planDirectWrite(ctx, await state(), edit, opts);
    if (!plan.ok) throw new Error(plan.error.message);
    return applyDirectWrite(ctx, await state(), plan.value);
  };
  const upstream = (path = "library.yaml") => h.git(["show", `main:${path}`], { cwd: repo.path });
  return { sb, h, repo, ctx, state, write, upstream };
}

describe("direct write mode", () => {
  it("WRITE-13: clones or pulls, edits the clone, commits and pushes to the branch", async () => {
    const { h, repo, write, upstream } = await setup();
    const res = await write({ op: "add", entries: [entry] });
    expect(res).toEqual({
      ok: true,
      value: { mode: "direct", catalog: "team", changed: true, path: expect.stringMatching(/clones\/team\/library\.yaml$/), committed: true, pushed: true, branch: "main" },
      warnings: [],
    });
    expect(upstream()).toContain("- name: b");
    expect(h.git(["log", "-1", "--format=%s", "main"], { cwd: repo.path })).toBe("library: added skill b");
  });

  it("WRITE-15: plans against the file as it is after the pull, so an upstream change survives", async () => {
    const { repo, write, upstream, ctx, state } = await setup();
    await planDirectWrite(ctx, await state(), { op: "add", entries: [] }); // clones the catalog
    repo.commit({ "library.yaml": catalog.replace("description: A", "description: A, upstream") });
    await write({ op: "update", type: "skill", name: "a", fields: { source: "https://github.com/o/s/blob/main/a2/SKILL.md" } });
    expect(upstream()).toContain("description: A, upstream");
    expect(upstream()).toContain("a2/SKILL.md");
  });

  it("WRITE-17: a dry run still pulls, returns the diff by yaml path, and commits nothing", async () => {
    const { sb, repo, write, upstream } = await setup();
    const before = repo.head();
    const res = await write({ op: "add", entries: [entry] }, { dryRun: true });
    expect(res).toMatchObject({ ok: true, value: { committed: false, pushed: false, diff: expect.stringMatching(/^--- a\/library\.yaml\n/) } });
    expect(repo.head()).toBe(before);
    expect(upstream()).toBe(catalog.trimEnd()); // the harness trims git output
    expect(await sb.host.fs.exists(`${sb.host.paths.appData}/clones/team/.git`)).toBe(true);
  });

  it("WRITE-09: a push refused because upstream moved is a warning, and leaves the clone diverged for doctor", async () => {
    const { sb, repo, ctx, state, upstream } = await setup();
    const plan = await planDirectWrite(ctx, await state(), { op: "add", entries: [entry] });
    if (!plan.ok) throw new Error(plan.error.message);
    repo.commit({ "library.yaml": catalog + "# someone else\n" });

    const res = await applyDirectWrite(ctx, await state(), plan.value);
    expect(res).toMatchObject({ ok: true, value: { committed: true, pushed: false } });
    expect(res.warnings).toEqual([{ message: expect.stringMatching(/^committed locally but not pushed: push failed: /) }]);
    expect(upstream()).not.toContain("- name: b");
    expect(await catalogStatus(sb.host, ctx.git, ref)).toMatchObject({ diverged: true });
  });

  it("WRITE-09: a refusal for lack of access says so", () => {
    expect(pushError("remote: Permission to o/cat.git denied to someone.\nfatal: unable to access\n", "https://github.com/o/cat.git")).toBe(
      "push rejected — you lack write access to https://github.com/o/cat.git. Ask for write access, or use a pull request instead",
    );
    expect(pushError(" ! [remote rejected] HEAD -> main (protected branch hook declined)\n", "r")).toMatch(/^push rejected/);
    expect(pushError(" ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'x'\n", "r")).toBe("push failed: error: failed to push some refs to 'x'");
  });

  it("WRITE-13: a failed commit is a warning; the file is written, and nothing is pushed", async () => {
    const { write, upstream } = await setup((host) => ({
      ...host,
      proc: {
        run: (program, args, o) =>
          args.includes("commit") ? Promise.resolve({ code: 1, stdout: "", stderr: "fatal: unable to auto-detect email address\n", durationMs: 1 }) : host.proc.run(program, args, o),
      },
    }));
    const res = await write({ op: "add", entries: [entry] });
    expect(res).toMatchObject({ ok: true, value: { changed: true, committed: false, pushed: false } });
    expect(res.warnings).toEqual([{ message: "library.yaml was written but not committed: git commit failed: fatal: unable to auto-detect email address" }]);
    expect(upstream()).toBe(catalog.trimEnd()); // the harness trims git output
  });

  it("a no-op runs no commit; an unreachable catalog can't be planned", async () => {
    const { sb, write, ctx } = await setup();
    const res = await write({ op: "update", type: "skill", name: "a", fields: { description: "A" } });
    expect(res).toMatchObject({ ok: true, value: { changed: false, committed: false } });
    expect(sb.audit.some((e) => e.kind === "proc:start" && e.argv.includes("commit"))).toBe(false);

    const gone = { ...ref, id: "gone", repo: "https://github.com/o/gone.git" };
    const goneState = (await loadRegistry(sb.host, { version: 1, catalogs: [gone], pins: {}, settings: {} })).catalogs()[0]!;
    expect(await planDirectWrite(ctx, goneState, { op: "add", entries: [entry] })).toMatchObject({ ok: false, error: { code: "GIT_FAILED" } });
  });
});

describe("WRITE-12: commit and PR copy", () => {
  it("names the edit in the commit, title and body", () => {
    expect(editCopy({ op: "add", entries: [entry] })).toEqual({
      commit: "library: added skill b",
      title: "library: add skill b",
      body: "Adds `b` (skill) to the catalog.\n\nSource: https://github.com/o/s/blob/main/b/SKILL.md",
    });
    expect(editCopy({ op: "add", entries: [entry, { ...entry, type: "prompt", name: "p", source: "/p.md" }] })).toEqual({
      commit: "library: add 2 entries (b, p)",
      title: "library: add 2 entries",
      body: "- `b` (skill) — https://github.com/o/s/blob/main/b/SKILL.md\n- `p` (prompt) — /p.md",
    });
    expect(editCopy({ op: "remove", type: "agent", name: "g" })).toEqual({
      commit: "library: removed agent g",
      title: "library: remove agent g",
      body: "Removes `g` (agent) from the catalog.",
    });
    expect(editCopy({ op: "update", type: "skill", name: "a", fields: {} })).toEqual({
      commit: "library: updated skill a",
      title: "library: updated skill a",
      body: "Updates `a` (skill) in the catalog.",
    });
  });
});
