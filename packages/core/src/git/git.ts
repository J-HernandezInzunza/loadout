// System git over HostProc (architecture.md §5.1, §5.2). Every call is non-interactive (FETCH-03),
// every network call has a timeout and takes an AbortSignal, and nothing ever writes to a child's
// stdin (spikes.md S1). For an https URL on a host with a connected account, the token reaches git
// through a per-command credential helper reading two environment variables (§5.5): never argv, a
// remote URL, .git/config or the audit log.
import type { AccountHost } from "../accounts/accounts.ts";
import type { Host, ProcResult } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";
import { cloneUrls, type RemoteSource } from "../source/source.ts";

export interface GitClientOptions {
  /** the connected account's token; anything but ok means "no token", so git falls back to ssh/https as usual */
  tokenFor?: (on: AccountHost) => Promise<Result<string>>;
  /** per network command; default two minutes */
  timeoutMs?: number;
}

export interface CallOpts {
  signal?: AbortSignal;
}

export interface CloneOpts extends CallOpts {
  branch: string;
  /** `--filter=blob:none --no-checkout`: trees only, for probing oids (UPD-02) */
  blobless?: boolean;
}

export interface GitClient {
  /** FETCH-02: ssh then https; https first when the host has a connected account. */
  urlsFor(src: Pick<RemoteSource, "kind" | "org" | "repo">): Promise<string[]>;
  /** Shallow single-branch clone into `dest`, trying each url into a fresh `dest` (A30). */
  clone(urls: string[], dest: string, opts: CloneOpts): Promise<Result<{ url: string }>>;
  /** UPD-01: the sha of `refs/heads/<branch>` exactly (A5), from the first url that answers; null if none does. */
  lsRemoteHead(urls: string[], branch: string, opts?: CallOpts): Promise<string | null>;
  /** UPD-02: a blobless no-checkout clone into `dest`; its HEAD commit. Read oids with `revParse`. */
  probe(urls: string[], branch: string, dest: string, opts?: CallOpts): Promise<Result<string>>;
  /** Local: the object a rev names in `dir`, or null. */
  revParse(dir: string, rev: string): Promise<string | null>;
  pullFfOnly(dir: string, opts?: CallOpts): Promise<Result<void>>;
  /**
   * RCAT-07, RCAT-10: after a fetch, commits HEAD is behind origin/<branch> and commits it has that
   * origin lacks; "unknown" when it could not fetch (A6).
   */
  divergence(dir: string, branch: string, opts?: CallOpts): Promise<{ behind: number; ahead: number } | "unknown">;
  /** Local: `remote.origin.url` of the clone at `dir`, or "" when it has none. */
  originUrl(dir: string): Promise<string>;
  /** Local: the work tree holding `dir`, its origin URL ("" for none) and checked-out branch; null outside a repo. */
  repoOf(dir: string): Promise<{ root: string; origin: string; branch: string } | null>;
  /** Local: stages `paths` and commits them with `message`; the new commit's sha. */
  commit(dir: string, paths: string[], message: string): Promise<Result<string>>;
  /** Local: stages `paths` (deletions included) and returns `git diff --cached`; "" when nothing changed. */
  stagedDiff(dir: string, paths: string[]): Promise<Result<string>>;
  /** Local: creates `name` at HEAD and checks it out. */
  checkoutBranch(dir: string, name: string): Promise<Result<void>>;
  /** Local: `git show HEAD`, the last commit with its patch. */
  showHead(dir: string): Promise<string>;
  /** `git push origin <refspec>` (extra args before it, e.g. `-u`); a refusal is classified as WRITE-09 says. */
  push(dir: string, refspec: string, opts?: CallOpts & { args?: string[] }): Promise<Result<void>>;
}

/** FETCH-03. GIT_SSH_COMMAND is always set: the core cannot see the user's environment, and a Finder launch carries none. */
export const nonInteractiveEnv: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/true",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
};

const tokenHosts: Record<string, { account: AccountHost; user: string }> = {
  "github.com": { account: "github", user: "x-access-token" },
  // Atlassian's documented username for OAuth access tokens.
  "bitbucket.org": { account: "bitbucket", user: "x-token-auth" },
};

// An empty helper first drops the user's helpers for this command, so osxkeychain never stores the token.
const credentialArgs = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$LOADOUT_GIT_USER" "$LOADOUT_GIT_TOKEN"; }; f',
];

/**
 * The line worth showing from git's stderr: the first `fatal:`/`remote:`/`error:` line, else the
 * last line; plus the ssh reason (`Permission denied (publickey).`, `Host key verification failed.`)
 * that the CLI dropped (A31).
 */
export function gitErrorSummary(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const main = lines.find((l) => /^(fatal|remote|error):/i.test(l)) ?? lines.at(-1) ?? "unknown error";
  const ssh = lines.findLast((l) => /^ssh:|Permission denied|Host key verification failed/i.test(l));
  return ssh === undefined || ssh === main ? main : `${main} (${ssh})`;
}

// WRITE-09: what a push refused for lack of access says, in git's or the host's words.
const DENIED = ["denied", "permission", "403", "forbidden", "not authorized", "protected branch", "remote rejected", "remote: error"];

/** WRITE-09: a refused push names the access problem; anything else carries git's summary. */
export function pushError(stderr: string, repo: string): string {
  const low = stderr.toLowerCase();
  if (DENIED.some((d) => low.includes(d))) {
    return `push rejected — you lack write access to ${repo}. Ask for write access, or use a pull request instead`;
  }
  return `push failed: ${gitErrorSummary(stderr)}`;
}

export function createGitClient(host: Host, opts: GitClientOptions = {}): GitClient {
  const timeoutMs = opts.timeoutMs ?? 120_000;

  /** -c args and env for `url`: the token helper on a connected host's https URL, nothing otherwise. */
  async function authFor(url: string): Promise<{ args: string[]; env: Record<string, string> }> {
    const m = /^https:\/\/([^/@]+)\//.exec(url);
    const target = m ? tokenHosts[m[1]!] : undefined;
    const token = target && opts.tokenFor ? await opts.tokenFor(target.account) : undefined;
    if (!target || !token?.ok) return { args: [], env: {} };
    return { args: credentialArgs, env: { LOADOUT_GIT_USER: target.user, LOADOUT_GIT_TOKEN: token.value } };
  }

  /** A network command against `url`. Rejects only on abort or a missing git. */
  async function network(url: string, args: string[], cwd: string | undefined, call: CallOpts): Promise<ProcResult & { summary: string }> {
    const auth = await authFor(url);
    const res = await host.proc.run("git", [...auth.args, ...args], {
      ...(cwd !== undefined && { cwd }),
      env: { ...nonInteractiveEnv, ...auth.env },
      timeoutMs,
      ...(call.signal && { signal: call.signal }),
    });
    const timedOut = res.code !== 0 && res.durationMs >= timeoutMs;
    return { ...res, summary: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : gitErrorSummary(res.stderr) };
  }

  const local = (dir: string, args: string[]) => host.proc.run("git", ["-C", dir, ...args], { env: { ...nonInteractiveEnv } });

  async function originUrl(dir: string): Promise<string> {
    return (await local(dir, ["config", "--get", "remote.origin.url"])).stdout.trim();
  }

  async function removeIfPresent(path: string) {
    if (!(await host.fs.exists(path))) return;
    await host.fs.remove(path, { recursive: true });
    host.audit({ kind: "fs", op: "delete", path });
  }

  async function revParse(dir: string, rev: string): Promise<string | null> {
    const res = await local(dir, ["rev-parse", "--verify", "--quiet", rev]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async function clone(urls: string[], dest: string, o: CloneOpts): Promise<Result<{ url: string }>> {
    const flags = ["--depth", "1", "--single-branch", "--branch", o.branch, ...(o.blobless ? ["--filter=blob:none", "--no-checkout"] : [])];
    let last = "no URL to try";
    for (const url of urls) {
      await removeIfPresent(dest);
      const res = await network(url, ["clone", "--quiet", ...flags, url, dest], undefined, o);
      if (res.code === 0) return ok({ url });
      last = res.summary;
    }
    await removeIfPresent(dest);
    return err({ code: "GIT_FAILED", message: `clone failed for ${repoName(urls)}: ${last}` });
  }

  return {
    async urlsFor(src) {
      const [ssh, https] = cloneUrls(src) as [string, string];
      return (await authFor(https)).args.length > 0 ? [https, ssh] : [ssh, https];
    },

    clone,

    async lsRemoteHead(urls, branch, o = {}) {
      const ref = `refs/heads/${branch}`;
      for (const url of urls) {
        const res = await network(url, ["ls-remote", url, ref], undefined, o);
        if (res.code !== 0) continue;
        const line = res.stdout.split("\n").find((l) => l.split("\t")[1] === ref);
        if (line) return line.split("\t")[0]!;
      }
      return null;
    },

    async probe(urls, branch, dest, o = {}) {
      const cloned = await clone(urls, dest, { ...o, branch, blobless: true });
      if (!cloned.ok) return cloned;
      const commit = await revParse(dest, "HEAD");
      return commit === null ? err({ code: "GIT_FAILED", message: `probe of ${repoName(urls)} has no HEAD` }) : ok(commit);
    },

    revParse,

    async pullFfOnly(dir, o = {}) {
      const res = await network(await originUrl(dir), ["-C", dir, "pull", "--quiet", "--ff-only"], undefined, o);
      return res.code === 0 ? ok(undefined) : err({ code: "GIT_FAILED", message: `pull failed: ${res.summary}` });
    },

    async divergence(dir, branch, o = {}) {
      const fetched = await network(await originUrl(dir), ["-C", dir, "fetch", "--quiet", "origin", branch], undefined, o);
      if (fetched.code !== 0) return "unknown";
      // "<ahead>\t<behind>": left side is HEAD, right side origin.
      const res = await local(dir, ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`]);
      const [ahead, behind] = res.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      return res.code === 0 && Number.isInteger(ahead) && Number.isInteger(behind) ? { behind: behind!, ahead: ahead! } : "unknown";
    },

    originUrl,

    async repoOf(dir) {
      const top = await local(dir, ["rev-parse", "--show-toplevel"]);
      if (top.code !== 0) return null;
      const root = top.stdout.trim();
      // symbolic-ref names the branch even before its first commit; a detached HEAD falls back to main.
      const branch = (await local(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      return { root, origin: await originUrl(root), branch: branch === "" ? "main" : branch };
    },

    async commit(dir, paths, message) {
      const added = await local(dir, ["add", "--", ...paths]);
      if (added.code !== 0) return err({ code: "GIT_FAILED", message: `git add failed: ${gitErrorSummary(added.stderr)}` });
      const committed = await local(dir, ["commit", "--quiet", "-m", message]);
      if (committed.code !== 0) return err({ code: "GIT_FAILED", message: `git commit failed: ${gitErrorSummary(committed.stderr || committed.stdout)}` });
      const sha = await revParse(dir, "HEAD");
      return sha === null ? err({ code: "GIT_FAILED", message: "git commit left no HEAD" }) : ok(sha);
    },

    async stagedDiff(dir, paths) {
      const added = await local(dir, ["add", "--", ...paths]);
      if (added.code !== 0) return err({ code: "GIT_FAILED", message: `git add failed: ${gitErrorSummary(added.stderr)}` });
      return ok((await local(dir, ["diff", "--cached", "--no-color"])).stdout);
    },

    async checkoutBranch(dir, name) {
      const res = await local(dir, ["checkout", "--quiet", "-b", name]);
      return res.code === 0 ? ok(undefined) : err({ code: "GIT_FAILED", message: `git checkout -b ${name} failed: ${gitErrorSummary(res.stderr)}` });
    },

    async showHead(dir) {
      return (await local(dir, ["show", "--no-color", "HEAD"])).stdout;
    },

    async push(dir, refspec, o = {}) {
      const origin = await originUrl(dir);
      const res = await network(origin, ["-C", dir, "push", "--quiet", ...(o.args ?? []), "origin", refspec], undefined, o);
      if (res.code === 0) return ok(undefined);
      return err({ code: "GIT_FAILED", message: res.summary.startsWith("timed out") ? `push failed: ${res.summary}` : pushError(res.stderr, origin) });
    },
  };
}

/** `<org>/<repo>` from the first url, for messages. */
function repoName(urls: string[]): string {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(urls[0] ?? "");
  return m?.[1] ?? urls[0] ?? "repo";
}
