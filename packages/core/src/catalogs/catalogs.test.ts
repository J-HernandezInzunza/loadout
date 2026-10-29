import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import type { AppConfigV1 } from "../config/config.ts";
import { createGitClient } from "../git/git.ts";
import type { CatalogRef } from "../model/model.ts";
import { createLibrary } from "../ops/library.ts";
import { loadRegistry } from "../registry/registry.ts";
import type { GitClient } from "../git/git.ts";
import { cloneUrls } from "../source/source.ts";
import { catalogStatus, catalogUrls, refreshCatalogs, sameRepo } from "./catalogs.ts";

const yaml = (...names: string[]) =>
  "library:\n  skills:\n" + names.map((n) => `    - name: ${n}\n      description: ${n}\n      source: /x/${n}/SKILL.md\n`).join("");

const remote = (id: string, repo: string, branch = "main"): CatalogRef => ({
  id,
  kind: "remote",
  repo,
  yamlPath: "library.yaml",
  branch,
  protected: true,
});

const config = (catalogs: CatalogRef[]): AppConfigV1 => ({ version: 1, catalogs, pins: {}, settings: {} });

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const git = createGitClient(sb.host);
  const clone = (id: string) => join(sb.host.paths.appData, "clones", id);
  const procs = () => sb.audit.filter((e) => e.kind === "proc:start").length;
  const refresh = async (refs: CatalogRef[]) => {
    const r = await refreshCatalogs(sb.host, git, refs);
    if (!r.ok) throw new Error(r.error.message);
    return r;
  };
  return { sb, h, git, clone, procs, refresh };
}

describe("persistent catalog clones", () => {
  it("RCAT-01: clones every remote catalog to clones/<id>, `shared` included", async () => {
    const { h, clone, refresh } = await setup();
    h.createRepo("github.com", "o/a").commit({ "library.yaml": yaml("one") });
    h.createRepo("bitbucket.org", "ws/b").commit({ "library.yaml": yaml("two") });
    const refs = [remote("shared", "git@github.com:o/a.git"), remote("team", "https://bitbucket.org/ws/b.git")];

    const res = await refresh(refs);
    expect(res).toEqual({ ok: true, value: [{ id: "shared", outcome: "cloned" }, { id: "team", outcome: "cloned" }], warnings: [] });
    expect(readFileSync(join(clone("shared"), "library.yaml"), "utf8")).toBe(yaml("one"));
    expect(readFileSync(join(clone("team"), "library.yaml"), "utf8")).toBe(yaml("two"));
  });

  it("RCAT-03: clones shallow on the catalog's branch, then fast-forwards on the next refresh", async () => {
    const { h, clone, refresh } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml("one") });
    repo.commit({ "library.yaml": yaml("dev") }, { branch: "dev" });
    const refs = [remote("team", "git@github.com:o/cat.git", "dev")];

    await refresh(refs);
    expect(h.git(["rev-parse", "--is-shallow-repository"], { cwd: clone("team") })).toBe("true");
    expect(h.git(["branch", "-r"], { cwd: clone("team") })).toBe("origin/dev");

    repo.commit({ "library.yaml": yaml("dev", "more") }, { branch: "dev" });
    expect((await refresh(refs)).value).toEqual([{ id: "team", outcome: "pulled" }]);
    expect(readFileSync(join(clone("team"), "library.yaml"), "utf8")).toBe(yaml("dev", "more"));
  });

  it("RCAT-04: a failed pull warns and keeps the cached copy", async () => {
    const { sb, h, refresh } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml("one") });
    const refs = [remote("team", "https://github.com/o/cat.git")];
    await refresh(refs);
    // The branch is gone upstream, so the pull can't fetch it.
    h.git(["update-ref", "-d", "refs/heads/main"], { cwd: repo.path });

    const res = await refresh(refs);
    expect(res.value).toEqual([{ id: "team", outcome: "cached" }]);
    expect(res.warnings).toEqual([{ message: expect.stringMatching(/^catalog 'team': pull failed: .+; using the cached copy$/) }]);
    const registry = await loadRegistry(sb.host, config(refs));
    expect(registry.entriesOf("team").map((e) => e.name)).toEqual(["one"]);
  });

  it("RCAT-05 (A3): an unclonable catalog is skipped with a reason and the others still serve", async () => {
    const { sb, h, refresh } = await setup();
    h.createRepo("github.com", "o/good").commit({ "library.yaml": yaml("one") });
    const refs = [remote("broken", "git@github.com:o/missing.git"), remote("good", "git@github.com:o/good.git")];

    const res = await refresh(refs);
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([{ id: "broken", outcome: "skipped" }, { id: "good", outcome: "cloned" }]);
    expect(res.warnings).toEqual([{ message: expect.stringMatching(/^catalog 'broken' skipped: clone failed for o\/missing: /) }]);

    const registry = await loadRegistry(sb.host, config(refs));
    expect(registry.entries()).toMatchObject({ ok: true, value: [{ name: "one", catalog: "good" }] });
    expect(registry.catalogs()[0]).toMatchObject({ skipped: expect.stringContaining("not cloned yet") });
  });

  it("RCAT-06 (R12): reads never clone or pull; an uncloned remote stays skipped", async () => {
    const { sb, h, procs } = await setup();
    h.createRepo("github.com", "o/cat").commit({ "library.yaml": yaml("one") });
    await sb.host.fs.writeTextAtomic(join(sb.host.paths.appData, "config.json"), JSON.stringify(config([remote("team", "git@github.com:o/cat.git")])));

    const library = createLibrary(sb.host);
    await library.list();
    await library.catalogs();
    await library.show("one");
    expect(procs()).toBe(0);
    expect(await sb.host.fs.exists(join(sb.host.paths.appData, "clones"))).toBe(false);
  });

  it("A20: a clone dir of another repo is not reused for this catalog", async () => {
    const { h, clone, refresh } = await setup();
    h.createRepo("github.com", "o/old").commit({ "library.yaml": yaml("old") });
    h.createRepo("github.com", "o/new").commit({ "library.yaml": yaml("new") });
    await refresh([remote("team", "git@github.com:o/old.git")]);

    const res = await refresh([remote("team", "git@github.com:o/new.git")]);
    expect(res.value).toEqual([{ id: "team", outcome: "skipped" }]);
    expect(res.warnings[0]!.message).toBe(
      `catalog 'team' skipped: ${clone("team")} is a clone of https://github.com/o/old.git, not git@github.com:o/new.git`,
    );
    expect(readFileSync(join(clone("team"), "library.yaml"), "utf8")).toBe(yaml("old"));

    // The same repo spelled another way is the same catalog.
    const same = await refresh([remote("team", "https://GitHub.com/o/old")]);
    expect(same.value).toEqual([{ id: "team", outcome: "pulled" }]);
  });

  it("leaves local catalogs alone", async () => {
    const { sb, git, procs, refresh } = await setup();
    const res = await refresh([{ id: "mine", kind: "local", path: join(sb.root, "library.yaml") }]);
    expect(res).toEqual({ ok: true, value: [], warnings: [] });
    expect(procs()).toBe(0);
    expect(await catalogStatus(sb.host, git, { id: "mine", kind: "local", path: "/x" })).toEqual({ id: "mine", state: "local" });
  });
});

describe("catalog status", () => {
  it("RCAT-07: counts commits behind after a fetch, without pulling", async () => {
    const { sb, h, git, clone, refresh } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml("one") });
    const ref = remote("team", "git@github.com:o/cat.git");
    expect(await catalogStatus(sb.host, git, ref)).toEqual({ id: "team", state: "not-cloned", clone: clone("team") });

    await refresh([ref]);
    repo.commit({ "library.yaml": yaml("two") });
    repo.commit({ "library.yaml": yaml("three") });
    expect(await catalogStatus(sb.host, git, ref)).toEqual({
      id: "team",
      state: "cloned",
      clone: clone("team"),
      behind: 2,
      ahead: 0,
      diverged: false,
    });
    expect(readFileSync(join(clone("team"), "library.yaml"), "utf8")).toBe(yaml("one"));
  });

  it("RCAT-07 (A6): says unknown, not 0, when it could not fetch", async () => {
    const { sb, h, git, refresh } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml("one") });
    const ref = remote("team", "git@github.com:o/cat.git");
    await refresh([ref]);
    h.git(["update-ref", "-d", "refs/heads/main"], { cwd: repo.path });
    expect(await catalogStatus(sb.host, git, ref)).toMatchObject({ behind: "unknown", ahead: "unknown", diverged: false });
  });

  it("RCAT-10 (A4): detects a clone that kept a local commit while origin moved on", async () => {
    const { sb, h, git, clone, refresh } = await setup();
    const repo = h.createRepo("github.com", "o/cat");
    repo.commit({ "library.yaml": yaml("one") });
    const ref = remote("team", "git@github.com:o/cat.git");
    await refresh([ref]);

    // A direct write whose push failed, then someone else pushed.
    h.git(["commit", "--allow-empty", "-q", "-m", "unpushed"], { cwd: clone("team") });
    expect(await catalogStatus(sb.host, git, ref)).toMatchObject({ behind: 0, ahead: 1, diverged: false });
    repo.commit({ "library.yaml": yaml("one", "theirs") });
    expect(await catalogStatus(sb.host, git, ref)).toMatchObject({ behind: 1, ahead: 1, diverged: true });
    expect((await refresh([ref])).warnings).toEqual([
      { message: expect.stringMatching(/^catalog 'team': pull failed: .*; using the cached copy$/) },
    ]);
  });
});

describe("Bitbucket's new SSH host", () => {
  const git = { urlsFor: async (src: Parameters<GitClient["urlsFor"]>[0]) => cloneUrls(src) } as GitClient;
  const ref = (repo: string) => ({ id: "shared", kind: "remote" as const, repo, branch: "develop", yamlPath: "library.yaml", protected: true });

  it("tries the ssh URL as registered, then https on bitbucket.org", async () => {
    expect(await catalogUrls(git, ref("git@ssh.bitbucket.org:sedteam/agent-library.git"))).toEqual([
      "git@ssh.bitbucket.org:sedteam/agent-library.git",
      "https://bitbucket.org/sedteam/agent-library.git",
    ]);
    expect(await catalogUrls(git, ref("https://bitbucket.org/sedteam/agent-library.git"))).toEqual([
      "git@bitbucket.org:sedteam/agent-library.git",
      "https://bitbucket.org/sedteam/agent-library.git",
    ]);
  });

  it("is the same repo as the old host's spelling of it", () => {
    expect(sameRepo("git@ssh.bitbucket.org:sedteam/agent-library.git", "git@bitbucket.org:sedteam/agent-library.git")).toBe(true);
  });
});
