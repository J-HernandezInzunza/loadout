import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createAccounts } from "../accounts/accounts.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef } from "../model/model.ts";
import { loadRegistry } from "../registry/registry.ts";
import { applyPrWrite, compareUrl, planPrWrite, prBranchName, type PrCtx } from "./pr.ts";

const catalog = "library:\n  skills:\n    - name: a\n      description: A\n      source: https://github.com/o/s/blob/main/a/SKILL.md\n  agents: []\n  prompts: []\n";
const entry = { type: "skill" as const, name: "my skill", description: "B", source: "https://github.com/o/s/blob/main/b/SKILL.md", requires: [] };
// Local time, as the branch name uses it.
const now = new Date(2026, 9, 28, 14, 5, 9);

async function setup(host: "github.com" | "bitbucket.org" = "github.com", opts: { connect?: boolean } = {}) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const slug = host === "github.com" ? "o/cat" : "ws/cat";
  const repo = h.createRepo(host, slug);
  repo.commit({ "library.yaml": catalog });
  const ref: CatalogRef = { id: "team", kind: "remote", repo: `https://${host}/${slug}.git`, yamlPath: "library.yaml", branch: "main", protected: true };
  const clocked = { ...sb.host, now: () => now };
  const stub = await createApiStub();
  const kind = host === "github.com" ? "github" : "bitbucket";
  const ctx: PrCtx = { host: clocked, git: createGitClient(clocked), apiBases: stub.bases };
  if (opts.connect !== false) {
    stub.addToken(kind, "tok", "me");
    const accounts = createAccounts(clocked, createConfigStore(clocked), { apiBases: stub.bases });
    await accounts.connect(kind, { accessToken: "tok" });
    ctx.accounts = accounts;
  }
  const state = async () => (await loadRegistry(clocked, { version: 1, catalogs: [ref], pins: {}, settings: {} })).catalogs()[0]!;
  const write = async (edit: Parameters<typeof planPrWrite>[2], o: { dryRun?: boolean } = {}) => {
    const plan = await planPrWrite(ctx, await state(), edit, o);
    if (!plan.ok) throw new Error(plan.error.message);
    return applyPrWrite(ctx, await state(), plan.value);
  };
  const tmp = () => readdir(join(sb.host.paths.appData, "tmp")).catch(() => []);
  /** Pull-request calls only; connecting the account looks up /user. */
  const prCalls = () => stub.requests.filter((r) => r.path.includes("pull"));
  return { sb, h, repo, stub, ctx, write, tmp, prCalls };
}

describe("PR write mode", () => {
  it("WRITE-07, WRITE-08, WRITE-12: branch, commit and PR request, exactly", async () => {
    const { h, repo, stub, write, tmp } = await setup();
    const res = await write({ op: "add", entries: [entry] });
    const branch = "library/add-my-skill-20261028T140509";
    expect(res).toEqual({
      ok: true,
      value: {
        mode: "pr",
        catalog: "team",
        changed: true,
        method: "api",
        branch,
        prUrl: "https://github.com/o/cat/pull/1",
        compareUrl: `https://github.com/o/cat/compare/main...${branch}?expand=1`,
      },
      warnings: [],
    });
    expect(h.git(["log", "-1", "--format=%s", branch], { cwd: repo.path })).toBe("library: added skill my skill");
    expect(h.git(["show", `${branch}:library.yaml`], { cwd: repo.path })).toContain("- name: my skill");
    expect(h.git(["show", "main:library.yaml"], { cwd: repo.path })).toBe(catalog.trimEnd()); // main untouched; the harness trims
    const post = stub.requests.find((r) => r.method === "POST")!;
    expect(post.path).toBe("/repos/o/cat/pulls");
    expect(JSON.parse(post.body)).toEqual({
      title: "library: add skill my skill",
      head: branch,
      base: "main",
      body: "Adds `my skill` (skill) to the catalog.\n\nSource: https://github.com/o/s/blob/main/b/SKILL.md",
    });
    expect(await tmp()).toEqual([]);
  });

  it("WRITE-08 (A15): adds -2, -3 when the branch already exists on the remote", async () => {
    const { repo, write } = await setup();
    const base = prBranchName({ op: "remove", type: "skill", name: "a" }, now);
    expect(base).toBe("library/remove-a-20261028T140509");
    repo.setBranch(base, repo.head());
    repo.setBranch(`${base}-2`, repo.head());
    expect(await write({ op: "remove", type: "skill", name: "a" })).toMatchObject({ ok: true, value: { branch: `${base}-3` } });
    expect(prBranchName({ op: "add", entries: [entry, entry] }, now)).toBe("library/add-batch-2-entries-20261028T140509");
    expect(prBranchName({ op: "update", type: "prompt", name: "a.b/c", fields: {} }, now)).toBe("library/update-a-b-c-20261028T140509");
  });

  it("WRITE-09: a refused push is an error, and the temp clone is still removed", async () => {
    const { sb, ctx, tmp } = await setup();
    const reg = await loadRegistry(sb.host, {
      version: 1,
      catalogs: [{ id: "team", kind: "remote", repo: "https://github.com/o/cat.git", yamlPath: "library.yaml", branch: "main", protected: true }],
      pins: {},
      settings: {},
    });
    const state = reg.catalogs()[0]!;
    const plan = await planPrWrite(ctx, state, { op: "add", entries: [entry] });
    if (!plan.ok) throw new Error(plan.error.message);
    const denying = { ...ctx, git: { ...ctx.git, push: async () => ({ ok: false as const, error: { code: "GIT_FAILED" as const, message: "push rejected — you lack write access to x" }, warnings: [] }) } };
    expect(await applyPrWrite(denying, state, plan.value)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^push rejected/) } });
    expect(await tmp()).toEqual([]);
  });

  it("WRITE-10: the compare URL for GitHub and Bitbucket, none for other hosts", () => {
    expect(compareUrl("git@github.com:o/r.git", "main", "library/x")).toBe("https://github.com/o/r/compare/main...library/x?expand=1");
    expect(compareUrl("https://bitbucket.org/ws/r.git", "dev", "library/x")).toBe("https://bitbucket.org/ws/r/pull-requests/new?source=library/x&dest=dev");
    expect(compareUrl("https://gitlab.com/o/r.git", "main", "b")).toBeNull();
  });

  it("WRITE-11: Bitbucket opens its PR through the API too", async () => {
    const { stub, write } = await setup("bitbucket.org");
    expect(await write({ op: "remove", type: "skill", name: "a" })).toMatchObject({
      ok: true,
      value: { method: "api", prUrl: "https://bitbucket.org/ws/cat/pull-requests/1", compareUrl: expect.stringContaining("pull-requests/new?source=library/remove-a-") },
    });
    expect(stub.pulls("bitbucket")).toHaveLength(1);
  });

  it("WRITE-11: with no account connected, the result is manual with the compare URL", async () => {
    const { stub, write } = await setup("github.com", { connect: false });
    const res = await write({ op: "add", entries: [entry] });
    expect(res).toMatchObject({ ok: true, value: { method: "manual", compareUrl: expect.stringMatching(/^https:\/\/github\.com\/o\/cat\/compare\/main\.\.\./) }, warnings: [] });
    expect(res.ok && "prUrl" in res.value).toBe(false);
    expect(stub.requests).toEqual([]);
  });

  it("WRITE-11: an API failure is a warning with the compare URL; the branch stays pushed", async () => {
    const { h, repo, stub, write } = await setup();
    stub.failNext({ api: "github", method: "POST" }, 502, { message: "Bad Gateway" });
    const res = await write({ op: "add", entries: [entry] });
    expect(res).toMatchObject({ ok: true, value: { method: "manual", compareUrl: expect.any(String) } });
    expect(res.warnings[0]!.message).toMatch(/^the branch is pushed, but the pull request couldn't be opened \(GitHub answered HTTP 502/);
    expect(h.git(["branch", "--list", "library/*"], { cwd: repo.path })).toContain("library/add-my-skill-");
  });

  it("Q2: a write whose PR already exists returns the existing PR's URL", async () => {
    const { stub, write } = await setup();
    // An open PR for the very branch this write will push.
    await fetch(`${stub.bases.github}/repos/o/cat/pulls`, {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "earlier", head: "library/add-my-skill-20261028T140509", base: "main", body: "" }),
    });
    expect(await write({ op: "add", entries: [entry] })).toMatchObject({ ok: true, value: { method: "api", prUrl: "https://github.com/o/cat/pull/1" } });
    expect(stub.pulls("github")).toHaveLength(1);
  });

  it("WRITE-17: a dry run commits in the temp clone, returns git show HEAD, and pushes nothing", async () => {
    const { h, repo, write, tmp, prCalls } = await setup();
    const res = await write({ op: "add", entries: [entry] }, { dryRun: true });
    expect(res).toMatchObject({ ok: true, value: { mode: "pr", method: "manual", diff: expect.stringMatching(/^commit [0-9a-f]{40}\n[\s\S]*library: added skill my skill[\s\S]*\+ {4}- name: my skill/) } });
    expect(h.git(["branch", "--list", "library/*"], { cwd: repo.path })).toBe("");
    expect(prCalls()).toEqual([]);
    expect(await tmp()).toEqual([]);
  });

  it("a no-op commits nothing and opens no PR", async () => {
    const { h, repo, write, prCalls } = await setup();
    expect(await write({ op: "update", type: "skill", name: "a", fields: { description: "A" } })).toEqual({
      ok: true,
      value: { mode: "pr", catalog: "team", changed: false, method: "manual", branch: null },
      warnings: [],
    });
    expect(h.git(["branch", "--list", "library/*"], { cwd: repo.path })).toBe("");
    expect(prCalls()).toEqual([]);
  });
});
