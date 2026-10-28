// WRITE-05's hint (Q13 b): the GitHub or Bitbucket browser URL of a local file, when it sits in a git
// repo whose origin is on one of those hosts, so a teammate-facing catalog gets a URL instead of a
// path. Each miss says why, because each has a different fix.
import type { GitClient } from "../git/git.ts";
import type { Host } from "../host.ts";
import { expandHome, remoteWeb } from "../source/source.ts";

export interface SourceSuggestion {
  url: string | null;
  /** why there's no URL; empty when there is one */
  why: string;
}

const miss = (why: string): SourceSuggestion => ({ url: null, why });

export async function suggestSource(host: Host, git: GitClient, input: string): Promise<SourceSuggestion> {
  let path = expandHome(input, host.paths.home);
  const kind = await host.fs.stat(path).then((s) => s.kind, () => null);
  if (kind === null) return miss(`${path} doesn't exist`);
  // A source names a file (a /blob/ link); a folder stands for its main file.
  if (kind === "dir") {
    let main: string | null = null;
    for (const name of ["SKILL.md", "AGENT.md"]) if (main === null && (await host.fs.exists(`${path}/${name}`))) main = `${path}/${name}`;
    if (main === null) return miss(`${path} is a directory with no SKILL.md or AGENT.md to point at`);
    path = main;
  }
  const repo = await git.repoOf(path.slice(0, path.lastIndexOf("/")));
  if (!repo) return miss("not inside a git repository");
  if (repo.origin === "") return miss(`${repo.root} has no 'origin' remote`);
  const web = remoteWeb(repo.origin);
  if (!web || (web[0] !== "github.com" && web[0] !== "bitbucket.org")) return miss(`origin is not a GitHub or Bitbucket remote (${repo.origin})`);
  const [webHost, owner, name] = web;
  // Real paths on both sides: macOS reaches temp dirs through /var -> /private/var.
  const [real, root] = await Promise.all([host.fs.realPath(path), host.fs.realPath(repo.root)]);
  if (!real.startsWith(root + "/")) return miss(`${path} is outside ${repo.root}`);
  const rel = real.slice(root.length + 1);
  return webHost === "github.com"
    ? { url: `https://github.com/${owner}/${name}/blob/${repo.branch}/${rel}`, why: "" }
    : { url: `https://bitbucket.org/${owner}/${name}/src/${repo.branch}/${rel}`, why: "" };
}
