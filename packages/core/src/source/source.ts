// Entry sources (behaviors.md §1.5, FETCH-01): the four GitHub and Bitbucket URL forms, or a local
// path. `~` expands against the host's home, which the caller passes in.
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

/** `[host, org, repo]` of a git remote URL, for linking to it in a browser; anything else is null. */
export function remoteWeb(url: string): [string, string, string] | null {
  const s = strip(url);
  for (const form of REMOTES) {
    const m = form.exec(s);
    if (m) return [m[1]!, m[2]!, m[3]!];
  }
  return null;
}
