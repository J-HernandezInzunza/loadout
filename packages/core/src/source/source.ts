// Entry sources (behaviors.md §1.5, FETCH-01): the four GitHub and Bitbucket URL forms, or a local
// path. `~` expands against the host's home, which the caller passes in.
import type { AccountHost } from "../accounts/accounts.ts";
import { strip } from "../catalog/python.ts";
import { LibraryError, type Source } from "../model/model.ts";

export type RemoteSource = Extract<Source, { kind: "github" | "bitbucket" }>;

// `[^\n]`: Python's `.`, which (unlike JS's) matches `\r`.
const FORMS: [RegExp, RemoteSource["kind"]][] = [
  [/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^\n]+)$/, "github"],
  [/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/([^\n]+)$/, "github"],
  [/^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/src\/([^/]+)\/([^\n]+)$/, "bitbucket"],
  [/^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/([^\n]+)$/, "bitbucket"],
];

/** posixpath.expanduser for `~` and `~/…`; another user's `~name` is left as written. */
export function expandHome(path: string, home: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  return home.replace(/\/+$/, "") + path.slice(1) || "/";
}

export function parseSource(input: string, home: string): Source {
  const s = strip(input);
  if (s.startsWith("/") || s.startsWith("~")) return { kind: "local", path: expandHome(s, home) };
  for (const [form, kind] of FORMS) {
    const m = form.exec(s);
    if (!m) continue;
    const [, org = "", repo = "", branch = "", rest = ""] = m;
    const filePath = rest.split("?")[0]!.split("#")[0]!;
    const slash = filePath.lastIndexOf("/");
    return {
      kind,
      org,
      repo: repo.endsWith(".git") ? repo.slice(0, -4) : repo,
      branch,
      filePath,
      // posixpath.dirname: trailing slashes go, unless the head is all slashes.
      parentPath: filePath.slice(0, slash + 1).replace(/(?<=[^/])\/+$/, ""),
      filename: filePath.slice(slash + 1),
    };
  }
  throw new LibraryError("INVALID_SOURCE", `unrecognized source format: ${input}`);
}

/** ssh first, then https; raw.githubusercontent.com sources clone from github.com. */
export function cloneUrls(src: Pick<RemoteSource, "kind" | "org" | "repo">): string[] {
  const host = src.kind === "bitbucket" ? "bitbucket.org" : "github.com";
  return [`git@${host}:${src.org}/${src.repo}.git`, `https://${host}/${src.org}/${src.repo}.git`];
}

const REMOTES = [
  /^git@([^:/]+):([^/]+)\/(.+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  /^https:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
];

/** SSH-only hosts and the web host they stand for: Bitbucket Cloud is moving SSH to its own host. */
const WEB_HOSTS: Record<string, string> = { "ssh.bitbucket.org": "bitbucket.org" };

/** The host Loadout has accounts for that a git remote lives on, or null for any other. */
export function accountHostOf(url: string): AccountHost | null {
  const web = remoteWeb(url)?.[0];
  if (web === "github.com") return "github";
  if (web === "bitbucket.org") return "bitbucket";
  return null;
}

/** A repository named by whatever link the user had to hand, reduced to what registering it needs. */
export interface RepoLink {
  /** what to register: an ssh URL as given, else `https://<host>/<org>/<repo>.git` */
  repo: string;
  on: AccountHost | null;
  org: string;
  name: string;
  /** from a deep link's `/tree/<branch>/…`, `/src/<branch>/…` or `?at=<branch>` */
  branch?: string;
  /** from a deep link that ends at a .yaml file */
  yamlPath?: string;
}

/**
 * A repo page, a deeper browser link or a clone URL, for any host; null for anything else. Clone URLs are
 * rebuilt from host/org/repo (catalogUrls), so `.git` is never needed. A deep link's branch is its first
 * segment after `tree`/`blob` or `src`, so a branch whose name holds a `/` has to be typed separately.
 */
export function parseRepoLink(input: string): RepoLink | null {
  const s = strip(input);
  if (!/^https?:\/\//.test(s)) {
    const web = remoteWeb(s);
    return web ? { repo: s, on: accountHostOf(s), org: web[1], name: web[2] } : null;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = WEB_HOSTS[url.hostname] ?? url.hostname;
  const [org, rawName, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (org === undefined || rawName === undefined) return null;
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  const link: RepoLink = { repo: `https://${host}/${org}/${name}.git`, on: accountHostOf(`https://${host}/${org}/${name}`), org, name };
  const marker = link.on === "github" ? ["tree", "blob"] : link.on === "bitbucket" ? ["src"] : [];
  const [kind, ref, ...path] = rest;
  // A commit hash names no branch to follow.
  const isBranch = (r: string | undefined): r is string => r !== undefined && r !== "" && !/^[0-9a-f]{12,40}$/.test(r);
  const at = url.searchParams.get("at");
  if (link.on === "bitbucket" && isBranch(at ?? undefined)) link.branch = at!;
  else if (kind !== undefined && marker.includes(kind) && isBranch(ref)) link.branch = ref;
  if (kind !== undefined && marker.includes(kind) && /\.ya?ml$/.test(path.at(-1) ?? "")) link.yamlPath = path.join("/");
  return link;
}

/** `[host, org, repo]` of a git remote URL, for linking to it in a browser; anything else is null. */
export function remoteWeb(url: string): [string, string, string] | null {
  const s = strip(url);
  for (const form of REMOTES) {
    const m = form.exec(s);
    if (m) return [WEB_HOSTS[m[1]!] ?? m[1]!, m[2]!, m[3]!];
  }
  return null;
}
