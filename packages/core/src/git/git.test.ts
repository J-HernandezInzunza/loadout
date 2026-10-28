import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import type { AccountHost } from "../accounts/accounts.ts";
import type { Host, HostProc } from "../host.ts";
import { err, ok } from "../model/model.ts";
import { createGitClient, gitErrorSummary, type GitClientOptions } from "./git.ts";

type Call = { args: string[]; opts: Parameters<HostProc["run"]>[2] };

async function setup(opts: GitClientOptions & { wrap?: (run: HostProc["run"]) => HostProc["run"] } = {}) {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const calls: Call[] = [];
  const inner = opts.wrap ? opts.wrap(sb.host.proc.run) : sb.host.proc.run;
  const host: Host = {
    ...sb.host,
    proc: {
      run(program, args, o) {
        calls.push({ args, opts: o });
        return inner(program, args, o);
      },
    },
  };
  const git = createGitClient(host, opts);
  const dest = (name = "repo") => join(sb.root, "tmp", name);
  return { sb, h, host, git, calls, dest };
}

const tokens = (map: Partial<Record<AccountHost, string>>) => ({
  tokenFor: async (on: AccountHost) =>
    map[on] === undefined ? err({ code: "NOT_CONNECTED" as const, message: "no" }) : ok(map[on]),
});

describe("git client: clone", () => {
  it("FETCH-02: tries ssh first, falls back to https, and clones shallow on the branch", async () => {
    const { h, git, calls, dest } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "1\n" });
    remote.commit({ "a.md": "2\n" });
    remote.commit({ "x.md": "x\n" }, { branch: "other" });

    const urls = await git.urlsFor({ kind: "github", org: "o", repo: "r" });
    expect(urls).toEqual([remote.ssh, remote.https]);
    expect(await git.clone(urls, dest(), { branch: "main" })).toEqual({ ok: true, value: { url: remote.https }, warnings: [] });
    expect(readFileSync(join(dest(), "a.md"), "utf8")).toBe("2\n");
    expect(h.git(["rev-parse", "--is-shallow-repository"], { cwd: dest() })).toBe("true");
    expect(h.git(["branch", "-r"], { cwd: dest() })).toBe("origin/main");
    expect(calls.map((c) => c.args.at(-2))).toEqual([remote.ssh, remote.https]);
  });

  it("FETCH-02: on total failure removes the destination and keeps the last summary", async () => {
    const { h, sb, git, dest } = await setup();
    h.createRepo("github.com", "o/r");
    const res = await git.clone(["git@github.com:o/r.git", "https://github.com/o/missing.git"], dest(), { branch: "main" });
    expect(res).toMatchObject({ ok: false, error: { code: "GIT_FAILED" } });
    expect(!res.ok && res.error.message).toMatch(/^clone failed for o\/r: fatal: /);
    expect(await sb.host.fs.exists(dest())).toBe(false);
  });

  it("FETCH-02 (rebuild): a host with a connected account is tried over https first", async () => {
    const { git } = await setup(tokens({ bitbucket: "bb-tok" }));
    expect(await git.urlsFor({ kind: "bitbucket", org: "ws", repo: "lib" })).toEqual([
      "https://bitbucket.org/ws/lib.git",
      "git@bitbucket.org:ws/lib.git",
    ]);
    expect(await git.urlsFor({ kind: "github", org: "o", repo: "r" })).toEqual([
      "git@github.com:o/r.git",
      "https://github.com/o/r.git",
    ]);
  });

  it("A30: clones each attempt into a fresh directory", async () => {
    let first = true;
    const { h, git, dest } = await setup({
      wrap: (run) => async (program, args, o) => {
        if (args.includes("clone") && first) {
          first = false;
          // A failed attempt that leaves a half-made checkout behind.
          mkdirSync(dest(), { recursive: true });
          writeFileSync(join(dest(), "partial"), "");
          return { code: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly\n", durationMs: 1 };
        }
        return run(program, args, o);
      },
    });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "a\n" });
    expect(await git.clone([remote.https, remote.https], dest(), { branch: "main" })).toMatchObject({ ok: true });
    expect(h.git(["status", "--porcelain", "--ignored"], { cwd: dest() })).toBe("");
  });
});

describe("git client: environment", () => {
  it("FETCH-03: every git call is non-interactive, and network calls carry a timeout and the signal", async () => {
    const { h, git, calls, dest } = await setup({ timeoutMs: 5_000 });
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "a\n" });
    const signal = new AbortController().signal;

    await git.clone([remote.https], dest(), { branch: "main", signal });
    await git.lsRemoteHead([remote.https], "main", { signal });
    await git.pullFfOnly(dest(), { signal });
    await git.behindCount(dest(), "main", { signal });
    await git.revParse(dest(), "HEAD");

    for (const c of calls) {
      expect(c.opts.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/true",
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
      });
    }
    const network = calls.filter((c) => ["clone", "ls-remote", "pull", "fetch"].some((cmd) => c.args.includes(cmd)));
    expect(network).toHaveLength(4);
    for (const c of network) expect(c.opts).toMatchObject({ timeoutMs: 5_000, signal });
  });

  it("FETCH-03: an abort rejects with AbortError instead of resolving a failure", async () => {
    const { h, git, dest } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "a\n" });
    await expect(git.clone([remote.https], dest(), { branch: "main", signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("A31: the error summary keeps the ssh reason next to the fatal line", () => {
    const stderr = [
      "Cloning into 'repo'...",
      "git@github.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
    ].join("\n");
    expect(gitErrorSummary(stderr)).toBe(
      "fatal: Could not read from remote repository. (git@github.com: Permission denied (publickey).)",
    );
    expect(gitErrorSummary("Host key verification failed.\nfatal: Could not read from remote repository.\n")).toBe(
      "fatal: Could not read from remote repository. (Host key verification failed.)",
    );
    expect(gitErrorSummary("fatal: repository 'x' not found\n")).toBe("fatal: repository 'x' not found");
    expect(gitErrorSummary("just this\n")).toBe("just this");
    expect(gitErrorSummary("")).toBe("unknown error");
  });
});

describe("git client: remote heads and probes", () => {
  it("UPD-01: ls-remote answers for refs/heads/<branch> exactly (A5), from the first url that answers", async () => {
    const { h, git } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    const feature = remote.commit({ "f.md": "f\n" }, { branch: "feature/main" });
    h.git(["tag", "main", feature], { cwd: remote.path });

    expect(await git.lsRemoteHead([remote.ssh, remote.https], "main")).toBeNull();
    const main = remote.commit({ "a.md": "a\n" });
    expect(await git.lsRemoteHead([remote.ssh, remote.https], "main")).toBe(main);
    expect(await git.lsRemoteHead([remote.https], "feature/main")).toBe(feature);
    expect(await git.lsRemoteHead(["https://github.com/o/missing.git"], "main")).toBeNull();
  });

  it("UPD-02: a blobless probe gives the tip commit, and oids are read from it", async () => {
    const { h, git, dest } = await setup();
    const remote = h.createRepo("bitbucket.org", "ws/lib");
    const tip = remote.commit({ "skills/a/SKILL.md": "a\n", "prompts/p.md": "p\n" });

    const probed = await git.probe([remote.ssh, remote.https], "main", dest());
    expect(probed).toEqual({ ok: true, value: tip, warnings: [] });
    expect(h.git(["config", "remote.origin.promisor"], { cwd: dest() })).toBe("true");
    const tree = h.git(["rev-parse", `${tip}:skills/a`], { cwd: remote.path });
    expect(await git.revParse(dest(), `${tip}:skills/a`)).toBe(tree);
    expect(await git.revParse(dest(), `${tip}:prompts/p.md`)).toBe(h.git(["rev-parse", `${tip}:prompts/p.md`], { cwd: remote.path }));
    expect(await git.revParse(dest(), `${tip}:skills/gone`)).toBeNull();
  });

  it("UPD-02: a probe that can't clone is a GIT_FAILED result", async () => {
    const { git, dest } = await setup();
    expect(await git.probe(["https://github.com/o/missing.git"], "main", dest())).toMatchObject({
      ok: false,
      error: { code: "GIT_FAILED" },
    });
  });
});

describe("git client: persistent clones", () => {
  it("pulls fast-forward only and counts commits behind after a fetch", async () => {
    const { h, git, dest } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "1\n" });
    await git.clone([remote.https], dest(), { branch: "main" });
    expect(await git.behindCount(dest(), "main")).toBe(0);

    remote.commit({ "a.md": "2\n" });
    remote.commit({ "a.md": "3\n" });
    expect(await git.behindCount(dest(), "main")).toBe(2);
    expect(await git.pullFfOnly(dest())).toMatchObject({ ok: true });
    expect(readFileSync(join(dest(), "a.md"), "utf8")).toBe("3\n");
    expect(await git.behindCount(dest(), "main")).toBe(0);
  });

  it("a diverged clone fails to pull with a summary", async () => {
    const { h, git, dest } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    const base = remote.commit({ "a.md": "1\n" });
    await git.clone([remote.https], dest(), { branch: "main" });
    remote.setBranch("main", remote.commit({ "b.md": "b\n" }, { branch: "rewrite" }));
    h.git(["commit", "--allow-empty", "-q", "-m", "local"], { cwd: dest() });
    expect(base).not.toBe(remote.head());
    const res = await git.pullFfOnly(dest());
    expect(res).toMatchObject({ ok: false, error: { code: "GIT_FAILED" } });
    expect(!res.ok && res.error.message).toMatch(/^pull failed: fatal: /);
  });

  it("A6: behind count is unknown, not 0, when it could not fetch", async () => {
    const { h, git, dest } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "1\n" });
    await git.clone([remote.https], dest(), { branch: "main" });
    h.git(["remote", "set-url", "origin", "https://github.com/o/gone.git"], { cwd: dest() });
    expect(await git.behindCount(dest(), "main")).toBe("unknown");
  });
});

describe("git client: connected accounts", () => {
  it.each([
    ["github.com", "github", "x-access-token"],
    ["bitbucket.org", "bitbucket", "x-token-auth"],
  ] as const)("passes a %s token through the credential helper only", async (domain, account, user) => {
    const { sb, h, git, calls, dest } = await setup(tokens({ [account]: "tok-SECRET-1" }));
    const remote = h.createRepo(domain, "o/r");
    remote.commit({ "a.md": "a\n" });

    const urls = await git.urlsFor({ kind: account, org: "o", repo: "r" });
    expect(urls[0]).toBe(remote.https);
    expect(await git.clone(urls, dest(), { branch: "main" })).toMatchObject({ ok: true, value: { url: remote.https } });

    const call = calls.find((c) => c.args.includes("clone"))!;
    expect(call.opts.env).toMatchObject({ LOADOUT_GIT_USER: user, LOADOUT_GIT_TOKEN: "tok-SECRET-1" });
    expect(call.args.join(" ")).not.toContain("tok-SECRET-1");
    expect(JSON.stringify(sb.audit)).not.toContain("tok-SECRET-1");
    expect(readFileSync(join(dest(), ".git", "config"), "utf8")).not.toContain("tok-SECRET-1");
    expect(h.git(["config", "remote.origin.url"], { cwd: dest() })).toBe(remote.https);

    // A file:// remote never asks for credentials, so ask git what the helper answers (architecture.md §6).
    const helperArgs = call.args.slice(0, call.args.indexOf("clone"));
    const filled = execFileSync("git", [...helperArgs, "credential", "fill"], {
      env: { ...process.env, ...sb.gitEnv, ...call.opts.env },
      input: `protocol=https\nhost=${domain}\npath=o/r.git\n\n`,
      encoding: "utf8",
    });
    expect(filled).toContain(`username=${user}\npassword=tok-SECRET-1\n`);
  });

  it("uses no helper for ssh URLs, other hosts, or a host with no account", async () => {
    const { h, git, calls, dest } = await setup(tokens({ github: "tok" }));
    const remote = h.createRepo("bitbucket.org", "ws/r");
    remote.commit({ "a.md": "a\n" });
    await git.clone([remote.ssh, remote.https], dest(), { branch: "main" });
    await git.lsRemoteHead(["git@github.com:o/r.git", "https://gitlab.com/o/r.git"], "main");
    for (const c of calls) {
      expect(c.args).not.toContain("credential.helper=");
      expect(c.opts.env).not.toHaveProperty("LOADOUT_GIT_TOKEN");
    }
  });
});
