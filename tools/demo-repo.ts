// The demo repo (M16.08): writes J-HernandezInzunza/loadout-demo's content, from seedDemo's lists, into a new
// local repo, so it can be pushed and kept in step with the seed. `main` holds the catalog and its sources;
// `demo-stale-v2` is one commit on from `demo-stale-v1` (= main), changing release-notes; `demo-stale`
// starts at v1, and a profile seed moves it between the two.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoRepo, demoRepoContent } from "@loadout/sandbox";

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

export function writeDemoRepo(dir: string): string {
  const root = resolve(dir);
  if (existsSync(root)) throw new Error(`${root} already exists`);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const { main, ahead } = demoRepoContent();

  git("init", "--quiet", "--initial-branch=main");
  writeFiles(root, main);
  git("add", "--all");
  git("commit", "--quiet", "--message", "Add the demo team catalog");
  git("tag", "demo-stale-v1");
  git("branch", "demo-stale");

  // v2 on a branch of its own, so main stays at v1.
  git("switch", "--quiet", "--create", "ahead");
  writeFiles(root, ahead);
  git("commit", "--quiet", "--all", "--message", "release-notes: breaking changes first");
  git("tag", "demo-stale-v2");
  git("switch", "--quiet", "main");
  git("branch", "--delete", "--force", "ahead");

  git("remote", "add", "origin", `${demoRepo}.git`);
  return root;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node tools/demo-repo.ts <new folder>");
    process.exit(1);
  }
  const root = writeDemoRepo(dir);
  console.log(`demo repo written to ${root}; push with: git -C ${root} push origin main demo-stale --tags`);
}
