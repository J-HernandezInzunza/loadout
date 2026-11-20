// The demo repo (M16.08): main holds the catalog and its sources, and demo-stale moves between two tags that
// differ only in release-notes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoRepo, demoRepoContent } from "@loadout/sandbox";
import { writeDemoRepo } from "../tools/demo-repo.ts";

const temp = mkdtempSync(join(tmpdir(), "loadout-demo-repo-"));
const saved = { ...process.env };
beforeAll(() => {
  // Hermetic: no user git config (signing, hooks), a fixed identity.
  writeFileSync(join(temp, "gitconfig"), "");
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(temp, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Loadout Test",
    GIT_AUTHOR_EMAIL: "test@loadout.invalid",
    GIT_COMMITTER_NAME: "Loadout Test",
    GIT_COMMITTER_EMAIL: "test@loadout.invalid",
  });
});
afterAll(() => {
  process.env = saved;
  rmSync(temp, { recursive: true, force: true });
});

describe("tools/demo-repo.ts", () => {
  it("writes main, the two demo-stale tags and the branch, with origin on the demo repo", () => {
    const root = writeDemoRepo(join(temp, "repo"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const { main } = demoRepoContent();

    expect(git("ls-tree", "-r", "--name-only", "main").split("\n").sort()).toEqual(Object.keys(main).sort());
    expect(readFileSync(join(root, "library.yaml"), "utf8")).toContain(`source: ${demoRepo}/blob/demo-stale/skills/release-notes/SKILL.md`);
    expect(readFileSync(join(root, "library.yaml"), "utf8")).toContain(`source: ${demoRepo}/blob/main/skills/code-review/SKILL.md`);
    expect(git("rev-parse", "demo-stale")).toBe(git("rev-parse", "main"));
    expect(git("rev-parse", "demo-stale-v1^{commit}")).toBe(git("rev-parse", "main"));
    expect(git("diff", "--name-only", "demo-stale-v1", "demo-stale-v2")).toBe("skills/release-notes/SKILL.md");
    expect(git("remote", "get-url", "origin")).toBe(`${demoRepo}.git`);
    expect(git("branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["demo-stale", "main"]);
  });
});
