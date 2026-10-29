import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createAccounts } from "../accounts/accounts.ts";
import { createConfigStore } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import { applyInstall } from "../install/apply.ts";
import { planInstall } from "../install/plan.ts";
import type { CatalogRef } from "../model/model.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor, destState } from "../scan/scan.ts";
import { applyPush, planPush, type PushCtx, type PushRequest } from "./push.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const block = (section: string, name: string, source: string) =>
  `library:\n  ${section}:\n    - name: ${name}\n      description: D\n      source: ${source}\n`;
// Local time, as the branch name uses it.
const now = new Date(2026, 9, 28, 14, 5, 9);

async function setup(catalogs: Record<string, string>, opts: { connect?: boolean } = {}) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const host = { ...sb.host, now: () => now };
  const config = createConfigStore(host);
  const refs: CatalogRef[] = [];
  for (const [id, text] of Object.entries(catalogs)) {
    const path = join(sb.root, `${id}.yaml`);
    await put(path, text);
    refs.push({ id, kind: "local", path });
  }
  await config.saveConfig({ version: 1, catalogs: refs, pins: {}, settings: {} });
  const stub = await createApiStub();
  const ctx: PushCtx = { host, git: createGitClient(host), config, receipts: createReceiptStore(host), apiBases: stub.bases };
  if (opts.connect) {
    stub.addToken("github", "tok", "me");
    const accounts = createAccounts(host, config, { apiBases: stub.bases });
    await accounts.connect("github", { accessToken: "tok" });
    ctx.accounts = accounts;
  }
  const install = async (name: string, catalog?: string) => {
    const plan = await planInstall(ctx, { names: [name], ...(catalog && { catalog }) });
    if (!plan.ok) throw new Error(plan.error.message);
    const applied = await applyInstall(ctx, plan.value);
    if (!applied.ok || applied.value.stopped) throw new Error(JSON.stringify(applied));
  };
  const push = async (req: PushRequest, message?: string) => {
    const plan = await planPush(ctx, req);
    if (!plan.ok) return plan;
    return applyPush(ctx, plan.value, message === undefined ? {} : { message });
  };
  const state = async (dest: string) => {
    const receipt = await ctx.receipts.get(dest);
    return (await destState(host, dest, receipt.ok ? receipt.value : null)).state;
  };
  const tmp = () => readdir(join(host.paths.appData, "tmp")).catch(() => []);
  const prCalls = () => stub.requests.filter((r) => r.path.includes("pull"));
  return { sb, h, ctx, install, push, state, tmp, prCalls, home: host.paths.home };
}

describe("push to a local source", () => {
  it("replaces the skill's source folder with the copy, files only the source had included; the copy reads installed after (A28)", async () => {
    const { sb, ctx, install, push, state, home, tmp } = await setup({ mine: "" });
    const src = join(sb.root, "src", "sk");
    await put(join(src, "SKILL.md"), "v1\n");
    await put(join(src, "notes.md"), "keep?\n");
    await writeFile(join(sb.root, "mine.yaml"), block("skills", "sk", join(src, "SKILL.md")));
    await install("sk");
    const dest = destFor(home, "skill", "sk");
    await writeFile(join(dest, "SKILL.md"), "v2\n");
    await put(join(dest, "extra.md"), "new\n");
    await rm(join(dest, "notes.md"));
    await put(join(src, "only-in-source.md"), "gone after\n");
    expect(await state(dest)).toBe("drifted");

    const plan = await planPush(ctx, { name: "sk" });
    expect(plan.ok && plan.value.kind === "local" && plan.value.changes).toEqual({ added: ["extra.md"], removed: ["notes.md", "only-in-source.md"], modified: ["SKILL.md"] });

    const res = await push({ name: "sk" });
    expect(res).toEqual({ ok: true, value: { kind: "local", name: "sk", catalog: "mine", dest, note: null, changed: true, target: src }, warnings: [] });
    expect((await readdir(src)).sort()).toEqual(["SKILL.md", "extra.md"]);
    expect(await readFile(join(src, "SKILL.md"), "utf8")).toBe("v2\n");
    expect(await state(dest)).toBe("installed");
    expect(await tmp()).toEqual([]);
  });

  it("overwrites a prompt's source file; nothing to push when they match", async () => {
    const { sb, install, push, state, home } = await setup({ mine: "" });
    const src = join(sb.root, "src", "p.md");
    await put(src, "one\n");
    await writeFile(join(sb.root, "mine.yaml"), block("prompts", "p", src));
    await install("p");
    const dest = destFor(home, "prompt", "p");

    const same = await push({ name: "p" });
    expect(same.ok && same.value.changed).toBe(false);

    await writeFile(dest, "two\n");
    const res = await push({ name: "p" });
    expect(res.ok && res.value).toMatchObject({ kind: "local", changed: true, target: src });
    expect(await readFile(src, "utf8")).toBe("two\n");
    expect(await state(dest)).toBe("installed");
  });

  it("STALE_PLAN when the copy or the source changes between plan and apply", async () => {
    const { sb, ctx, install, home } = await setup({ mine: "" });
    const src = join(sb.root, "src", "p.md");
    await put(src, "one\n");
    await writeFile(join(sb.root, "mine.yaml"), block("prompts", "p", src));
    await install("p");
    const dest = destFor(home, "prompt", "p");
    await writeFile(dest, "two\n");

    const first = await planPush(ctx, { name: "p" });
    await writeFile(dest, "three\n");
    expect(first.ok && (await applyPush(ctx, first.value))).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });

    const second = await planPush(ctx, { name: "p" });
    await writeFile(src, "upstream\n");
    expect(second.ok && (await applyPush(ctx, second.value))).toMatchObject({ ok: false, error: { code: "STALE_PLAN" } });
    expect(await readFile(src, "utf8")).toBe("upstream\n");
  });

  it("refuses a copy that isn't there, a symlinked copy, and a skill whose folder is a repository's root", async () => {
    const { sb, push, home } = await setup({ mine: "" });
    const repo = join(sb.root, "repo");
    await put(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await put(join(repo, "SKILL.md"));
    await writeFile(join(sb.root, "mine.yaml"), block("skills", "sk", join(repo, "SKILL.md")));
    expect(await push({ name: "sk" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "'sk' is not installed; nothing to push" } });

    const dest = destFor(home, "skill", "sk");
    await mkdir(dirname(dest), { recursive: true });
    await symlink(repo, dest);
    expect(await push({ name: "sk" })).toMatchObject({ ok: false, error: { code: "REFUSED" } });

    await rm(dest);
    await put(join(dest, "SKILL.md"));
    expect(await push({ name: "sk" })).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE" } });
  });
});

describe("push to a remote source", () => {
  const skill = "https://github.com/o/s/blob/main/sk/SKILL.md";

  it("commits the copy on library/update-<name>-<ts>, pushes it and opens the PR; the copy reads installed after (A28)", async () => {
    const { h, install, push, state, home, tmp, prCalls } = await setup({ mine: block("skills", "sk", skill) }, { connect: true });
    const repo = h.createRepo("github.com", "o/s");
    repo.commit({ "sk/SKILL.md": "v1\n", "sk/old.md": "old\n", "other/x.md": "x\n" });
    await install("sk");
    const dest = destFor(home, "skill", "sk");
    await writeFile(join(dest, "SKILL.md"), "v2\n");
    await rm(join(dest, "old.md"));

    const res = await push({ name: "sk" });
    const branch = "library/update-sk-20261028T140509";
    expect(res).toEqual({
      ok: true,
      value: {
        kind: "remote",
        name: "sk",
        catalog: "mine",
        dest,
        note: null,
        changed: true,
        pr: { method: "api", branch, prUrl: "https://github.com/o/s/pull/1", compareUrl: `https://github.com/o/s/compare/main...${branch}?expand=1` },
      },
      warnings: [],
    });
    expect(h.git(["log", "-1", "--format=%s", branch], { cwd: repo.path })).toBe("library: updated sk");
    expect(h.git(["show", `${branch}:sk/SKILL.md`], { cwd: repo.path })).toBe("v2");
    expect(h.git(["ls-tree", "-r", "--name-only", branch], { cwd: repo.path }).split("\n")).toEqual(["other/x.md", "sk/SKILL.md"]);
    expect(h.git(["show", "main:sk/SKILL.md"], { cwd: repo.path })).toBe("v1");
    expect(JSON.parse(prCalls().find((r) => r.method === "POST")!.body)).toEqual({
      title: "library: updated sk",
      head: branch,
      base: "main",
      body: "Updated skill `sk` via Loadout.",
    });
    expect(await state(dest)).toBe("installed");
    expect(await tmp()).toEqual([]);
  });

  it("previews the staged diff; nothing to push leaves the remote alone; a message becomes the commit and PR title", async () => {
    const { h, ctx, install, push, home, prCalls } = await setup({ mine: block("prompts", "p", "https://github.com/o/s/blob/main/p.md") });
    const repo = h.createRepo("github.com", "o/s");
    repo.commit({ "p.md": "one\n" });
    await install("p");

    expect(await push({ name: "p" })).toMatchObject({ ok: true, value: { changed: false, pr: null } });
    expect(h.git(["branch", "--list", "library/*"], { cwd: repo.path })).toBe("");

    await writeFile(destFor(home, "prompt", "p"), "two\n");
    const plan = await planPush(ctx, { name: "p" });
    expect(plan.ok && plan.value.kind === "remote" && plan.value.diff).toContain("-one\n+two");
    const res = plan.ok ? await applyPush(ctx, plan.value, { message: "tighten p" }) : plan;
    // No account connected: the branch is pushed and the PR is opened by hand.
    expect(res.ok && res.value.kind === "remote" && res.value.pr).toEqual({
      method: "manual",
      branch: "library/update-p-20261028T140509",
      compareUrl: "https://github.com/o/s/compare/main...library/update-p-20261028T140509?expand=1",
    });
    expect(h.git(["log", "-1", "--format=%s", "library/update-p-20261028T140509"], { cwd: repo.path })).toBe("tighten p");
    expect(prCalls()).toEqual([]);
  });

  it("refuses a skill at a repository's root", async () => {
    const { push, home } = await setup({ mine: block("skills", "sk", "https://github.com/o/s/blob/main/SKILL.md") });
    await put(join(destFor(home, "skill", "sk"), "SKILL.md"));
    expect(await push({ name: "sk" })).toMatchObject({ ok: false, error: { code: "INVALID_SOURCE" } });
  });
});

describe("push provenance note", () => {
  const twoCatalogs = async () => {
    const s = await setup({ first: "", second: "" });
    const a = join(s.sb.root, "a", "p.md");
    const b = join(s.sb.root, "b", "p.md");
    await put(a, "a\n");
    await put(b, "b\n");
    await writeFile(join(s.sb.root, "first.yaml"), block("prompts", "p", a));
    await writeFile(join(s.sb.root, "second.yaml"), block("prompts", "p", b));
    return { ...s, a, b };
  };

  it("silent when the receipt names the catalog pushed to", async () => {
    const { ctx, install } = await twoCatalogs();
    await install("p");
    expect(await planPush(ctx, { name: "p" })).toMatchObject({ ok: true, value: { note: null } });
  });

  it("names where the copy came from when the push targets another catalog, and leaves that receipt alone", async () => {
    const { ctx, install, push, state, home, a, b } = await twoCatalogs();
    await install("p");
    const dest = destFor(home, "prompt", "p");
    await writeFile(dest, "edited\n");
    const res = await push({ name: "p", catalog: "second" });
    expect(res.ok && res.value.note).toBe(
      `this copy of 'p' was installed from 'first' → ${a}, but this push targets 'second' → ${b}. Push to catalog 'first' to send it back where it came from.`,
    );
    expect(await readFile(b, "utf8")).toBe("edited\n");
    // The receipt describes `first`'s source, which still holds the old text.
    expect(await state(dest)).toBe("drifted");
    expect((await planPush(ctx, { name: "p" })).ok).toBe(true);
  });

  it("warns of the ambiguity when no receipt records the copy's origin", async () => {
    const { ctx, home, a, b } = await twoCatalogs();
    await put(destFor(home, "prompt", "p"), "by hand\n");
    const plan = await planPush(ctx, { name: "p" });
    expect(plan.ok && plan.value.note).toBe(
      `'p' is defined in more than one catalog and no install receipt records which copy is on disk. Pushing to 'first' → ${a} (also defined by 'second' → ${b})`,
    );
  });
});
