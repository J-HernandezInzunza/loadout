// Hermetic git remotes for tests (architecture.md §6): bare repos under the sandbox, served as
// file:// URLs (git ignores --depth and --filter for plain paths). The sandbox's git config maps
// the https forms of github.com and bitbucket.org onto them; the ssh forms stay unmapped, so a
// clone tries ssh, is refused by GIT_ALLOW_PROTOCOL=file, and falls back to https.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./sandbox.ts";

export type GitHost = "github.com" | "bitbucket.org";

export interface Remote {
  /** the bare repo on disk */
  path: string;
  /** file:// URL of the bare repo */
  url: string;
  https: string;
  ssh: string;
  /**
   * Commits on `branch` (default `main`, created when missing): a string writes the file, `null`
   * deletes it, unlisted files carry over from the branch's head. Returns the commit oid.
   */
  commit(files: Record<string, string | null>, opts?: { branch?: string; message?: string }): string;
  /** Creates or moves `branch` to `oid`. */
  setBranch(branch: string, oid: string): void;
  /** The oid `branch` points at. */
  head(branch?: string): string;
}

export interface GitHarness {
  /** Runs git with the sandbox's git env, outside the host (so it stays out of the audit log). */
  git(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string }): string;
  /** A bare repo reachable as `https://<host>/<slug>.git`, with `main` as its default branch. */
  createRepo(host: GitHost, slug: string): Remote;
}

export function createGitHarness(sb: Sandbox): GitHarness {
  const remotes = join(sb.root, "remotes");
  const hosts: GitHost[] = ["github.com", "bitbucket.org"];
  writeFileSync(
    sb.gitEnv.GIT_CONFIG_GLOBAL!,
    [
      "[user]\n\tname = Loadout Test\n\temail = test@loadout.invalid",
      "[init]\n\tdefaultBranch = main",
      "[commit]\n\tgpgsign = false",
      // A file:// server honours --filter only when it allows it (blobless probe, UPD-02).
      "[uploadpack]\n\tallowFilter = true",
      ...hosts.map((h) => `[url "file://${remotes}/${h}/"]\n\tinsteadOf = https://${h}/`),
    ].join("\n") + "\n",
  );

  const git: GitHarness["git"] = (args, opts = {}) =>
    execFileSync("git", args, {
      cwd: opts.cwd ?? sb.root,
      env: { ...process.env, ...opts.env, ...sb.gitEnv },
      encoding: "utf8",
      ...(opts.input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input: opts.input }),
    }).trim();

  return {
    git,
    createRepo(host, slug) {
      const path = join(remotes, host, `${slug}.git`);
      mkdirSync(path, { recursive: true });
      git(["init", "--bare", "--quiet", path]);
      const inRepo = (args: string[], env?: Record<string, string>) => git(args, { cwd: path, ...(env && { env }) });

      return {
        path,
        url: `file://${path}`,
        https: `https://${host}/${slug}.git`,
        ssh: `git@${host}:${slug}.git`,
        commit(files, { branch = "main", message = "commit" } = {}) {
          // Plumbing against a throwaway index: a bare repo has no worktree to stage in.
          const index = join(sb.root, `index-${process.hrtime.bigint()}`);
          const env = { GIT_INDEX_FILE: index };
          try {
            const parent = tryRevParse(inRepo, branch);
            inRepo(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
            // Mode 0 removes a path; --force-remove would need a worktree.
            const entries = Object.entries(files).map(([file, text]) =>
              text === null
                ? `0 ${"0".repeat(40)}\t${file}`
                : `100644 ${git(["hash-object", "-w", "--stdin"], { cwd: path, input: text })}\t${file}`,
            );
            git(["update-index", "--index-info"], { cwd: path, env, input: entries.join("\n") + "\n" });
            const tree = inRepo(["write-tree"], env);
            const oid = inRepo(["commit-tree", tree, "-m", message, ...(parent ? ["-p", parent] : [])]);
            inRepo(["update-ref", `refs/heads/${branch}`, oid]);
            return oid;
          } finally {
            rmSync(index, { force: true });
          }
        },
        setBranch(branch, oid) {
          inRepo(["update-ref", `refs/heads/${branch}`, oid]);
        },
        head(branch = "main") {
          return inRepo(["rev-parse", "--verify", `refs/heads/${branch}`]);
        },
      };
    },
  };
}

function tryRevParse(inRepo: (args: string[]) => string, branch: string): string | undefined {
  try {
    return inRepo(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}
