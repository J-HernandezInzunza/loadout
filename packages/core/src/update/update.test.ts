import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { fetchEntry } from "../fetch/fetch.ts";
import { createGitClient } from "../git/git.ts";
import { createOperation } from "../git/operation.ts";
import type { Entry } from "../model/model.ts";
import { createReceiptStore, type ReceiptV2 } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { checkUpdate, contentUnmoved, isStale, type UpdateCtx } from "./update.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const entry = (type: Entry["type"], name: string, source: string): Entry => ({ type, name, description: name, source, requires: [], catalog: "team" });
const gh = (path: string, repo = "r") => `https://github.com/o/${repo}/blob/main/${path}`;

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const git = createGitClient(sb.host);
  const receipts = createReceiptStore(sb.host);
  /** A fresh operation each time, as each sync run is one. */
  const ctx = async (): Promise<UpdateCtx> => ({ host: sb.host, op: await createOperation(sb.host, git), receipts });
  /** Fetches, copies into place and records a receipt, as apply will. */
  const install = async (e: Entry): Promise<ReceiptV2> => {
    const { op } = await ctx();
    const fetched = await fetchEntry(sb.host, git, op, e);
    if (!fetched.ok) throw new Error(fetched.error.message);
    const dest = destFor(sb.host.paths.home, e.type, e.name);
    await mkdir(dirname(dest), { recursive: true });
    await cp(fetched.value.staged, dest, { recursive: true });
    const receipt: ReceiptV2 = {
      dest,
      type: e.type,
      name: e.name,
      catalog: { id: "team", key: "k" },
      source: e.source,
      commit: fetched.value.commit,
      sourceOid: fetched.value.sourceOid,
      files: fetched.value.files,
      installedAt: "2026-10-28T12:00:00.000Z",
    };
    await receipts.put(receipt);
    await op.dispose();
    return receipt;
  };
  const lsRemotes = () => sb.audit.filter((e) => e.kind === "proc:start" && e.argv.includes("ls-remote")).length;
  return { sb, h, receipts, ctx, install, lsRemotes };
}

describe("update detection: remote sources", () => {
  it("UPD-04: up to date when the head is the receipt's commit and the copy is untouched", async () => {
    const { h, ctx, install } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n" });
    const e = entry("skill", "a", gh("skills/a/SKILL.md"));
    const receipt = await install(e);
    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "up-to-date" });
  });

  it("UPD-04: changed when anything is unknown: no receipt, a drifted copy, an unreachable remote, a moved source", async () => {
    const { h, ctx, install } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n" });
    const e = entry("skill", "a", gh("skills/a/SKILL.md"));
    const receipt = await install(e);

    expect(await checkUpdate(await ctx(), e, null)).toEqual({ status: "changed", why: "no receipt" });
    const unreachable = entry("skill", "a", gh("skills/a/SKILL.md", "gone"));
    expect(await checkUpdate(await ctx(), unreachable, { ...receipt, source: unreachable.source })).toEqual({
      status: "changed",
      why: "the remote head is unknown",
    });
    remote.commit({ "skills/a/SKILL.md": "a2\n" });
    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "changed", why: "the source moved" });
    await put(join(receipt.dest, "SKILL.md"), "edited\n");
    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "changed", why: "the installed copy is drifted" });
  });

  it("UPD-03, UPD-05: a moved head with unmoved content is skipped and the receipt's commit advances", async () => {
    const { h, ctx, install, receipts, lsRemotes } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n", "other.md": "1\n" });
    const e = entry("skill", "a", gh("skills/a/SKILL.md"));
    const receipt = await install(e);
    const tip = remote.commit({ "other.md": "2\n" });

    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "unmoved", tip });
    const advanced = await receipts.get(receipt.dest);
    expect(advanced).toMatchObject({ ok: true, value: { commit: tip, sourceOid: receipt.sourceOid } });

    // Next run: back on the single ls-remote path, no probe.
    const before = lsRemotes();
    const check = await ctx();
    expect(await checkUpdate(check, e, advanced.ok ? advanced.value : null)).toEqual({ status: "up-to-date" });
    expect(lsRemotes() - before).toBe(2); // ssh refused, https
  });

  it("UPD-03: a repointed source never borrows an oid, even for identical content", async () => {
    const { h, ctx, install } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n" });
    const fork = h.createRepo("github.com", "o/fork");
    fork.commit({ "skills/a/SKILL.md": "a\n" });
    const receipt = await install(entry("skill", "a", gh("skills/a/SKILL.md")));
    const repointed = entry("skill", "a", gh("skills/a/SKILL.md", "fork"));

    expect(await contentUnmoved(await ctx(), repointed, receipt)).toBeNull();
    // The fork's commit is byte-identical, so even the head matches: the source string decides.
    expect(await checkUpdate(await ctx(), repointed, receipt)).toEqual({ status: "changed", why: "the source was repointed" });
  });

  it("UPD-04: an entry repointed to another path at the same commit is changed, not up to date", async () => {
    const { h, ctx, install } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n", "skills/b/SKILL.md": "b\n" });
    const receipt = await install(entry("skill", "a", gh("skills/a/SKILL.md")));
    expect(await checkUpdate(await ctx(), entry("skill", "a", gh("skills/b/SKILL.md")), receipt)).toEqual({
      status: "changed",
      why: "the source was repointed",
    });
  });

  it("UPD-03: no oid recorded, or the path gone at the tip, can't prove anything", async () => {
    const { h, ctx, install } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "prompts/p.md": "p\n" });
    const e = entry("prompt", "p", gh("prompts/p.md"));
    const receipt = await install(e);
    remote.commit({ "prompts/p.md": null, "prompts/q.md": "q\n" });

    expect(await contentUnmoved(await ctx(), e, { ...receipt, sourceOid: null })).toBeNull();
    expect(await contentUnmoved(await ctx(), e, receipt)).toBeNull();
  });

  it("UPD-08: force always refetches", async () => {
    const { h, ctx, install } = await setup();
    h.createRepo("github.com", "o/r").commit({ "prompts/p.md": "p\n" });
    const e = entry("prompt", "p", gh("prompts/p.md"));
    const receipt = await install(e);
    expect(await checkUpdate(await ctx(), e, receipt, { force: true })).toEqual({ status: "changed", why: "forced" });
  });
});

describe("update detection: local sources", () => {
  it("UPD-04: a local skill is up to date while its folder's files equal what was installed", async () => {
    const { sb, ctx, install } = await setup();
    const src = join(sb.root, "work/skills/a");
    await put(join(src, "SKILL.md"), "a\n");
    await put(join(src, ".git/HEAD"), "ref\n");
    const e = entry("skill", "a", join(src, "SKILL.md"));
    const receipt = await install(e);

    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "up-to-date" });
    await put(join(src, "new.md"), "n\n");
    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "changed", why: "the local source differs" });
  });

  it("UPD-04: a local prompt compares bytes, whatever the source file is called", async () => {
    const { sb, ctx, install } = await setup();
    const src = join(sb.root, "drafts/review-v2.md");
    await put(src, "p\n");
    const e = entry("prompt", "review", src);
    const receipt = await install(e);

    expect(await checkUpdate(await ctx(), e, receipt)).toEqual({ status: "up-to-date" });
    await put(src, "p2\n");
    expect(await checkUpdate(await ctx(), e, receipt)).toMatchObject({ status: "changed" });
    await sb.host.fs.remove(src);
    expect(await checkUpdate(await ctx(), e, receipt)).toMatchObject({ status: "changed" });
  });
});

describe("staleness for list", () => {
  it("UPD-06: stale only when installed, remote, the head is known and moved, and the content moved too", async () => {
    const { h, ctx, install, receipts } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n", "other.md": "1\n" });
    const e = entry("skill", "a", gh("skills/a/SKILL.md"));
    const receipt = await install(e);
    expect(await isStale(await ctx(), e, receipt)).toBe(false);

    remote.commit({ "other.md": "2\n" });
    expect(await isStale(await ctx(), e, receipt)).toBe(false); // unmoved
    expect(await receipts.get(receipt.dest)).toMatchObject({ value: { commit: receipt.commit } }); // never advanced here

    remote.commit({ "skills/a/SKILL.md": "a2\n" });
    expect(await isStale(await ctx(), e, receipt)).toBe(true);
    const unreachable = entry("skill", "a", gh("skills/a/SKILL.md", "gone"));
    expect(await isStale(await ctx(), unreachable, { ...receipt, source: unreachable.source })).toBe(false); // unknown head
  });

  it("UPD-06: a local source, or a receipt without a commit, is never stale", async () => {
    const { sb, ctx, install } = await setup();
    await put(join(sb.root, "p.md"), "p\n");
    const e = entry("prompt", "p", join(sb.root, "p.md"));
    const receipt = await install(e);
    await put(join(sb.root, "p.md"), "changed\n");
    expect(await isStale(await ctx(), e, receipt)).toBe(false);
    const remote = entry("prompt", "p", gh("prompts/p.md"));
    expect(await isStale(await ctx(), remote, { ...receipt, source: remote.source, commit: null })).toBe(false);
  });
});
