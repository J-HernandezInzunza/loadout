import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createGitClient } from "../git/git.ts";
import { suggestSource } from "./suggest.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const git = createGitClient(sb.host);
  /** A work tree at `rel` with `origin` set (none when undefined) on `branch`. */
  const repo = async (rel: string, origin?: string, branch = "main") => {
    const dir = join(sb.root, rel);
    await mkdir(dir, { recursive: true });
    h.git(["init", "-q", "-b", branch, dir]);
    if (origin !== undefined) h.git(["remote", "add", "origin", origin], { cwd: dir });
    return dir;
  };
  const suggest = (path: string) => suggestSource(sb.host, git, path);
  return { sb, repo, suggest };
}

describe("suggestSource", () => {
  it.each([
    ["GitHub ssh", "git@github.com:o/lib.git", "https://github.com/o/lib/blob/main/skills/a/SKILL.md"],
    ["GitHub https", "https://github.com/o/lib.git", "https://github.com/o/lib/blob/main/skills/a/SKILL.md"],
    ["Bitbucket ssh", "git@bitbucket.org:ws/lib.git", "https://bitbucket.org/ws/lib/src/main/skills/a/SKILL.md"],
    ["Bitbucket https", "https://bitbucket.org/ws/lib.git", "https://bitbucket.org/ws/lib/src/main/skills/a/SKILL.md"],
  ])("WRITE-05: a file in a repo with a %s origin gets its browser URL", async (_, origin, url) => {
    const { repo, suggest } = await setup();
    const dir = await repo("work/lib", origin);
    await put(join(dir, "skills/a/SKILL.md"));
    expect(await suggest(join(dir, "skills/a/SKILL.md"))).toEqual({ url, why: "" });
  });

  it("names the checked-out branch, resolves a folder to its SKILL.md, and expands ~", async () => {
    const { repo, suggest } = await setup();
    const dir = await repo("home/lib", "git@github.com:o/lib.git", "dev");
    await put(join(dir, "skills/a/SKILL.md"));
    expect(await suggest(join(dir, "skills/a"))).toEqual({ url: "https://github.com/o/lib/blob/dev/skills/a/SKILL.md", why: "" });
    expect((await suggest("~/lib/skills/a/SKILL.md")).url).toBe("https://github.com/o/lib/blob/dev/skills/a/SKILL.md");
  });

  it("explains each miss: no repo, no origin, another host, no main file, nothing there", async () => {
    const { sb, repo, suggest } = await setup();
    await put(join(sb.root, "loose/p.md"));
    expect(await suggest(join(sb.root, "loose/p.md"))).toEqual({ url: null, why: "not inside a git repository" });

    const bare = await repo("bare");
    await put(join(bare, "p.md"));
    expect((await suggest(join(bare, "p.md"))).why).toMatch(/has no 'origin' remote$/);

    const lab = await repo("lab", "https://gitlab.com/o/r.git");
    await put(join(lab, "p.md"));
    expect((await suggest(join(lab, "p.md"))).why).toBe("origin is not a GitHub or Bitbucket remote (https://gitlab.com/o/r.git)");

    await mkdir(join(lab, "empty"));
    expect((await suggest(join(lab, "empty"))).why).toMatch(/is a directory with no SKILL\.md or AGENT\.md to point at$/);
    expect((await suggest(join(lab, "gone.md"))).why).toMatch(/doesn't exist$/);
  });
});
