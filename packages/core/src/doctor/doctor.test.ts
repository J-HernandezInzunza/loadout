import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createAccounts } from "../accounts/accounts.ts";
import { refreshCatalogs } from "../catalogs/catalogs.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { createConfigStore, type AppConfigV1 } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { Host } from "../host.ts";
import type { CatalogRef } from "../model/model.ts";
import { fileManifest } from "../receipts/hash.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { destFor } from "../scan/scan.ts";
import { doctor, recloneCatalog, type DoctorCtx, type Finding } from "./doctor.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const item = (name: string, source: string, requires?: string) =>
  `    - name: ${name}\n      description: d\n      source: ${source}\n${requires ? `      requires: [${requires}]\n` : ""}`;
const yaml = (sections: { skills?: string[]; agents?: string[]; prompts?: string[] }, head = "") =>
  `${head}library:\n` + (["skills", "agents", "prompts"] as const).map((s) => `  ${s}:\n${(sections[s] ?? []).join("")}`).join("");

async function setup(wrap: (h: Host) => Host = (h) => h) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  const h = createGitHarness(sb);
  const config = createConfigStore(host);
  const git = createGitClient(host);
  const ctx: DoctorCtx = {
    host,
    git,
    config,
    receipts: createReceiptStore(host),
    settings: createClaudeSettings(host),
    managedSettingsFile: join(sb.root, "managed-settings.json"),
  };
  /** Local catalogs written from text, then any remote refs. */
  const register = async (locals: Record<string, string>, remotes: CatalogRef[] = [], pins: Record<string, string> = {}) => {
    const catalogs: CatalogRef[] = [];
    for (const [id, text] of Object.entries(locals)) {
      const path = join(sb.root, `${id}.yaml`);
      await put(path, text);
      catalogs.push({ id, kind: "local", path });
    }
    await config.saveConfig({ version: 1, catalogs: [...catalogs, ...remotes], pins, settings: {} } satisfies AppConfigV1);
  };
  const run = async (opts: Parameters<typeof doctor>[1] = { noPull: true }) => {
    const r = await doctor(ctx, opts);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const checks = async (opts?: Parameters<typeof doctor>[1]) => {
    const r = await run(opts);
    return [...r.errors, ...r.warnings].map((f) => [f.check, f.severity, f.message] as const);
  };
  const local = (rel: string) => join(sb.root, rel);
  return { sb, h, ctx, register, run, checks, local, home: sb.host.paths.home };
}

const remote = (id: string, repo: string, extra: Partial<Extract<CatalogRef, { kind: "remote" }>> = {}): CatalogRef => ({
  id,
  kind: "remote",
  repo,
  yamlPath: "library.yaml",
  branch: "main",
  protected: false,
  ...extra,
});

const has = (findings: readonly (readonly [string, string, string])[], check: string, severity: Finding["severity"], message: string | RegExp) =>
  expect(findings).toContainEqual([check, severity, typeof message === "string" ? message : expect.stringMatching(message)]);

describe("doctor: environment and config", () => {
  it("reports ok with no findings on a healthy setup", async () => {
    const { register, run, local } = await setup();
    await put(local("s/a/SKILL.md"));
    await register({ team: yaml({ skills: [item("a", local("s/a/SKILL.md"))] }) });
    expect(await run()).toEqual({ status: "ok", entries: 1, errors: [], warnings: [] });
  });

  it("git: an error when git can't run, and the Xcode tools hint when it's Apple's shim", async () => {
    const missing = await setup((host) => ({ ...host, proc: { run: () => Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })) } }));
    await missing.register({ team: yaml({}) });
    has(await missing.checks(), "git", "error", /^git isn't installed/);

    const shim = await setup((host) => ({
      ...host,
      proc: { run: async () => ({ code: 1, stdout: "", stderr: "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)\n", durationMs: 1 }) },
    }));
    await shim.register({ team: yaml({}) });
    has(await shim.checks(), "xcode", "error", /xcode-select --install/);
  });

  it("3: no config, or no catalogs; 4: a config it can't read", async () => {
    const a = await setup();
    has(await a.checks(), "3", "error", /^no config at .*config\.json; register a catalog to start$/);
    await a.ctx.config.saveConfig({ version: 1, catalogs: [], pins: {}, settings: {} });
    has(await a.checks(), "3", "error", "no catalogs registered");
    await put(join(a.sb.host.paths.appData, "config.json"), "{");
    has(await a.checks(), "4", "error", /can read/);
  });
});

describe("doctor: remote catalogs", () => {
  it("7: a remote not yet cloned; 10: a repo that can't be reached", async () => {
    const { h, register, checks } = await setup();
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": yaml({}) });
    await register({}, [remote("ok", "git@github.com:o/cat.git"), remote("gone", "git@github.com:o/gone.git")]);
    const found = await checks();
    has(found, "7", "warning", /^catalog not yet cloned at .*clones\/ok; it clones on the next refresh$/);
    has(found, "10", "error", "catalog repo unreachable, or it has no branch 'main' (git@github.com:o/gone.git)");
    expect(found.filter(([c]) => c === "10")).toHaveLength(1);
  });

  it("8: a clone without origin, offering a re-clone; 9: a clone whose origin is another repo", async () => {
    const { sb, h, ctx, register, run } = await setup();
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": yaml({}) });
    h.createRepo("github.com", "o/other").commit({ "library.yaml": yaml({}) });
    const refs = [remote("a", "https://github.com/o/cat.git"), remote("b", "https://github.com/o/cat.git")];
    await register({}, refs);
    await refreshCatalogs(sb.host, ctx.git, refs);
    h.git(["remote", "remove", "origin"], { cwd: join(sb.host.paths.appData, "clones/a") });
    h.git(["remote", "set-url", "origin", "https://github.com/o/other.git"], { cwd: join(sb.host.paths.appData, "clones/b") });

    const report = await run();
    expect(report.errors).toContainEqual(expect.objectContaining({ check: "8", catalog: "a", action: { kind: "reclone", catalog: "a" } }));
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ check: "9", catalog: "b", message: "catalog clone remote (https://github.com/o/other.git) differs from the catalog's repo (https://github.com/o/cat.git)" }),
    );
  });

  it("13: pulls every remote unless told not to; 14 (RCAT-07): a clone behind, or that couldn't be checked", async () => {
    const { sb, h, ctx, register, checks } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml({}) });
    const ref = remote("team", "https://github.com/o/cat.git");
    await register({}, [ref]);
    await refreshCatalogs(sb.host, ctx.git, [ref]);
    repo.commit({ "library.yaml": yaml({}, "# one\n") });
    repo.commit({ "library.yaml": yaml({}, "# two\n") });

    has(await checks({ noPull: true }), "14", "warning", "clone is 2 commit(s) behind origin/main (catalog was not refreshed)");
    expect((await checks({})).filter(([c]) => c === "14")).toEqual([]);

    h.git(["update-ref", "-d", "refs/heads/main"], { cwd: repo.path });
    const offline = await checks({});
    has(offline, "13", "warning", /^catalog 'team': pull failed: /);
    has(offline, "14", "warning", "couldn't check whether the clone is behind origin/main");
  });

  it("A4 (RCAT-10): a diverged clone is an error with a re-clone action that fixes it", async () => {
    const { sb, h, ctx, register, run } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml({}) });
    const ref = remote("team", "https://github.com/o/cat.git");
    await register({}, [ref]);
    await refreshCatalogs(sb.host, ctx.git, [ref]);
    h.git(["commit", "--allow-empty", "-q", "-m", "unpushed"], { cwd: join(sb.host.paths.appData, "clones/team") });
    repo.commit({ "library.yaml": yaml({}, "# theirs\n") });

    const report = await run({ noPull: true });
    const diverged = report.errors.find((f) => f.check === "diverged")!;
    expect(diverged).toMatchObject({ catalog: "team", action: { kind: "reclone", catalog: "team" }, message: expect.stringContaining("1 local commit(s) not on origin") });

    expect(await recloneCatalog(ctx, "team")).toMatchObject({ ok: true });
    expect((await run({ noPull: true })).errors.filter((f) => f.check === "diverged")).toEqual([]);
  });

  it("accounts (replaces 11): a protected catalog's host needs a connected account whose token works", async () => {
    const { sb, h, ctx, register, checks } = await setup();
    h.createRepo("bitbucket.org", "ws/lib").commit({ "library.yaml": yaml({}) });
    const ref = remote("team", "https://bitbucket.org/ws/lib.git", { protected: true });
    await register({}, [ref, remote("open", "https://github.com/o/x.git")]);
    has(await checks(), "accounts", "warning", /^no Bitbucket account connected: writes to 'team' give a link/);

    const stub = await createApiStub();
    stub.addToken("bitbucket", "bb-1", "jose");
    const accounts = createAccounts(sb.host, ctx.config, { apiBases: stub.bases });
    await accounts.connect("bitbucket", { accessToken: "bb-1" });
    ctx.accounts = accounts;
    expect((await checks()).filter(([c]) => c === "accounts")).toEqual([]);
    stub.expireToken("bb-1");
    has(await checks(), "accounts", "warning", "the Bitbucket account: its token no longer works; connect it again in Accounts");
  });
});

describe("doctor: catalog content", () => {
  it("15: a catalog that can't be read is an error", async () => {
    const { register, checks } = await setup();
    await register({ ok: yaml({}), bad: "library: [\n" });
    has(await checks(), "15", "error", /^can't parse /);
  });

  it("16, 17: a catalog's default_dirs has no effect, and its legacy 'default' key is named", async () => {
    const { register, checks } = await setup();
    await register({ team: yaml({}, "default_dirs:\n  skills:\n    - default: .claude/skills\n") });
    const found = await checks();
    has(found, "16", "warning", /^catalog declares default_dirs, which has no effect: Loadout installs to /);
    has(found, "17", "warning", "default_dirs uses the legacy 'default' scope key (skills) — rename it to 'project' in the catalog");
  });

  it("18–25: duplicates, sources, requires (DEP-04), cycles (DEP-05) and sort order (EDIT-14)", async () => {
    const { register, checks, local } = await setup();
    await put(local("s/ok/SKILL.md"));
    const team = yaml({
      skills: [
        item("zeta", local("s/ok/SKILL.md"), "skill:alpha"),
        item("alpha", local("s/ok/SKILL.md"), "skill:zeta"),
        item("dup", local("s/ok/SKILL.md")),
        item("gone", local("nowhere/SKILL.md")),
        item("weird", "ftp://x"),
        item("refs", local("s/ok/SKILL.md"), '"nocolon", "widget:x", "prompt:elsewhere", "prompt:nowhere"'),
      ],
      prompts: [item("dup", local("s/ok/SKILL.md"))],
    });
    await register({ team, other: yaml({ prompts: [item("elsewhere", local("s/ok/SKILL.md"))] }) });
    const found = await checks();
    has(found, "18", "error", "duplicate name in skill, prompt");
    has(found, "19", "error", `local source not found: ${local("nowhere/SKILL.md")}`);
    has(found, "21", "error", "unrecognized source format: ftp://x");
    has(found, "22", "error", "malformed requires ref 'nocolon'");
    has(found, "22", "error", "malformed requires ref 'widget:x'");
    has(found, "23", "error", "dangling dependency 'prompt:elsewhere'; it exists in other, but dependencies resolve within one catalog — add a copy to 'team'");
    has(found, "23", "error", "dangling dependency 'prompt:nowhere'");
    has(found, "24", "error", "dependency cycle: skill:zeta -> skill:alpha -> skill:zeta");
    has(found, "25", "warning", "skills not alphabetically sorted");
  });

  it("20: a local source in a remote catalog won't resolve for teammates", async () => {
    const { sb, h, ctx, register, checks } = await setup();
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": yaml({ prompts: [item("p", "~/p.md")] }) });
    const ref = remote("team", "https://github.com/o/cat.git");
    await register({}, [ref]);
    await refreshCatalogs(sb.host, ctx.git, [ref]);
    has(await checks(), "20", "warning", "local source ~/p.md won't resolve for teammates pulling this catalog — a remote catalog's sources should be URLs");
  });

  it("26: --deep checks every remote source's repo and branch", async () => {
    const { h, register, checks } = await setup();
    h.createRepo("github.com", "o/r").commit({ "skills/a/SKILL.md": "a\n" });
    await register({
      team: yaml({
        skills: [item("a", "https://github.com/o/r/blob/main/skills/a/SKILL.md"), item("b", "https://github.com/o/r/blob/dev/skills/b/SKILL.md")],
      }),
    });
    expect((await checks()).filter(([c]) => c === "26")).toEqual([]);
    const deep = await checks({ noPull: true, deep: true });
    expect(deep.filter(([c]) => c === "26")).toEqual([["26", "error", "repo or branch unreachable: o/r@dev"]]);
  });

  it("27: a name in two catalogs; 28: pins nothing can honour, in three wordings", async () => {
    const { register, checks, local } = await setup();
    await put(local("p.md"));
    const p = (n: string) => item(n, local("p.md"));
    await register({ A: yaml({ prompts: [p("x"), p("y")] }), B: yaml({ prompts: [p("x"), p("y")] }) }, [], { y: "B", nope: "A", x: "C", "ghost-pin": "A" });
    const found = await checks();
    has(found, "27", "warning", "'x' is defined in 2 catalogs — 'A' overrides B");
    has(found, "27", "warning", "'y' is defined in 2 catalogs — 'B' (pinned) overrides A");
    has(found, "28", "warning", "'ghost-pin' is pinned to 'A', but no catalog defines that name; unpin it to drop the pin");
    has(found, "28", "warning", "'x' is pinned to 'C', which is not registered; it resolves from 'A' instead");
    await register({ A: yaml({ prompts: [p("x")] }), B: yaml({ prompts: [p("z")] }) }, [], { z: "A" });
    has(await checks(), "28", "warning", "'z' is pinned to 'A', which does not define it (defined in: B); it resolves from 'B' instead");
  });
});

describe("doctor: install dirs and settings", () => {
  it("29: drifted copies; 30: unmanaged copies of catalog entries; 31: receipts whose destination is gone", async () => {
    const { sb, ctx, register, checks, home, local } = await setup();
    await put(local("p.md"));
    const p = (n: string) => item(n, local("p.md"));
    await register({ team: yaml({ prompts: [p("edited"), p("hand"), p("gone")] }) });
    for (const n of ["edited", "gone"]) {
      const dest = destFor(home, "prompt", n);
      await put(dest, "orig\n");
      await ctx.receipts.put({ dest, type: "prompt", name: n, catalog: { id: "team", key: "k" }, source: local("p.md"), commit: null, sourceOid: null, files: await fileManifest(sb.host, dest), installedAt: "2026-10-28T12:00:00Z" });
    }
    await put(destFor(home, "prompt", "edited"), "mine\n");
    await sb.host.fs.remove(destFor(home, "prompt", "gone"));
    await put(destFor(home, "prompt", "hand"));
    await put(destFor(home, "prompt", "not-in-catalog"));

    const found = await checks();
    has(found, "29", "warning", `${destFor(home, "prompt", "edited")} has local edits (~edited.md); installing or syncing it shows them before overwriting`);
    has(found, "30", "warning", `${destFor(home, "prompt", "hand")} wasn't installed by Loadout (foreign); installing 'hand' asks before replacing it`);
    has(found, "31", "warning", `receipt points at ${destFor(home, "prompt", "gone")}, which no longer exists`);
    expect(found.some(([, , m]) => m.includes("not-in-catalog"))).toBe(false);
  });

  it("managed (arch §4.5 rule 4): managed settings that override a catalog skill", async () => {
    const { ctx, register, checks, local } = await setup();
    await put(local("s/SKILL.md"));
    await register({ team: yaml({ skills: [item("review", local("s/SKILL.md"))] }) });
    await put(ctx.managedSettingsFile!, JSON.stringify({ skillOverrides: { review: "off", unrelated: "off" } }));
    const found = await checks();
    has(found, "managed", "warning", "your organisation's managed settings set 'review' to off; turning it on or off in Loadout has no effect");
    expect(found.filter(([c]) => c === "managed")).toHaveLength(1);
  });
});
