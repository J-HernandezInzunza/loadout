// Persistent clones of remote catalogs at `<appData>/clones/<id>` (RCAT-01 without the CLI's `shared`
// special case). Refreshing clones what is absent and fast-forwards what is present; reads never do
// either (R12): they happen on launch, Refresh, and inside writes. One catalog failing is a warning
// for that catalog, never a failure of the rest (RCAT-04, and A3's fix of RCAT-05).
import type { Host } from "../host.ts";
import { ok, type CatalogRef, type Result, type Warning } from "../model/model.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import { remoteWeb } from "../source/source.ts";

type RemoteRef = Extract<CatalogRef, { kind: "remote" }>;

export interface CatalogRefresh {
  id: string;
  /** cached: the pull failed and the existing clone still serves (RCAT-04); skipped: nothing usable */
  outcome: "cloned" | "pulled" | "cached" | "skipped";
}

export type CatalogStatus =
  | { id: string; state: "local" }
  | { id: string; state: "not-cloned"; clone: string }
  | {
      id: string;
      state: "cloned";
      clone: string;
      /** commits behind / ahead of origin/<branch> after a fetch; "unknown" when it could not fetch (A6) */
      behind: number | "unknown";
      ahead: number | "unknown";
      /** has commits origin lacks and lacks commits origin has: `pull --ff-only` can never succeed (A4, RCAT-10) */
      diverged: boolean;
    };

export const cloneDir = (host: Host, id: string) => `${host.paths.appData}/clones/${id}`;

/** The URLs to clone a catalog from: FETCH-02's order for a GitHub or Bitbucket repo, else the URL as given. */
export async function catalogUrls(git: GitClient, ref: RemoteRef): Promise<string[]> {
  const web = remoteWeb(ref.repo);
  const kind = web?.[0] === "github.com" ? "github" : web?.[0] === "bitbucket.org" ? "bitbucket" : null;
  if (!kind || !web) return [ref.repo];
  const urls = await git.urlsFor({ kind, org: web[1], repo: web[2] });
  // A registered ssh URL is the ssh attempt, so the host it names (ssh.bitbucket.org) is the one tried.
  return ref.repo.startsWith("https://") ? urls : urls.map((u) => (u.startsWith("https://") ? u : ref.repo));
}

/** One repo, however it is spelled: ssh and https forms of the same host/org/repo are equal. */
export function sameRepo(a: string, b: string): boolean {
  const x = remoteWeb(a);
  const y = remoteWeb(b);
  if (!x || !y) return a === b;
  return x.every((part, i) => part.toLowerCase() === y[i]!.toLowerCase());
}

async function refreshOne(host: Host, git: GitClient, ref: RemoteRef, opts: CallOpts): Promise<{ outcome: CatalogRefresh["outcome"]; warning?: Warning }> {
  const clone = cloneDir(host, ref.id);
  if (!(await host.fs.exists(clone))) {
    const cloned = await git.clone(await catalogUrls(git, ref), clone, { ...opts, branch: ref.branch });
    if (cloned.ok) return { outcome: "cloned" };
    return { outcome: "skipped", warning: { message: `catalog '${ref.id}' skipped: ${cloned.error.message}` } };
  }
  // A20: a dir left by another catalog with the same id must not be reused as this one.
  const origin = await git.originUrl(clone);
  if (!sameRepo(origin, ref.repo)) {
    return {
      outcome: "skipped",
      warning: { message: `catalog '${ref.id}' skipped: ${clone} is a clone of ${origin || "nothing"}, not ${ref.repo}` },
    };
  }
  const pulled = await git.pullFfOnly(clone, opts);
  if (pulled.ok) return { outcome: "pulled" };
  return { outcome: "cached", warning: { message: `catalog '${ref.id}': ${pulled.error.message}; using the cached copy` } };
}

/** RCAT-03: clone absent remote catalogs, fast-forward present ones; per-catalog warnings, never an error. */
export async function refreshCatalogs(host: Host, git: GitClient, refs: CatalogRef[], opts: CallOpts = {}): Promise<Result<CatalogRefresh[]>> {
  const remotes = refs.filter((r): r is RemoteRef => r.kind === "remote");
  const done = await Promise.all(remotes.map((ref) => refreshOne(host, git, ref, opts)));
  return ok(
    done.map((d, i) => ({ id: remotes[i]!.id, outcome: d.outcome })),
    done.flatMap((d) => (d.warning ? [d.warning] : [])),
  );
}

/** RCAT-07, A4: how a catalog's clone stands against origin. Fetches; never pulls. */
export async function catalogStatus(host: Host, git: GitClient, ref: CatalogRef, opts: CallOpts = {}): Promise<CatalogStatus> {
  if (ref.kind === "local") return { id: ref.id, state: "local" };
  const clone = cloneDir(host, ref.id);
  if (!(await host.fs.exists(clone))) return { id: ref.id, state: "not-cloned", clone };
  const d = await git.divergence(clone, ref.branch, opts);
  if (d === "unknown") return { id: ref.id, state: "cloned", clone, behind: "unknown", ahead: "unknown", diverged: false };
  return { id: ref.id, state: "cloned", clone, ...d, diverged: d.ahead > 0 && d.behind > 0 };
}
