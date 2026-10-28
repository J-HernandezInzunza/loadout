import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "./git.ts";
import { createSandbox } from "./sandbox.ts";

async function setup() {
  const sb = await createSandbox();
  return { sb, h: createGitHarness(sb) };
}

describe("git harness", () => {
  it("shallow-clones https://github.com/o/r.git from the local bare repo", async () => {
    const { sb, h } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "one\n" });
    const head = remote.commit({ "a.md": "two\n", "dir/b.md": "b\n" });

    const dest = join(sb.root, "clone");
    const res = await sb.host.proc.run("git", ["clone", "--depth", "1", remote.https, dest], {});
    expect(res.stderr).toBe("Cloning into '" + dest + "'...\n");
    expect(res.code).toBe(0);
    expect(await sb.host.fs.readText(join(dest, "a.md"))).toBe("two\n");
    expect(await sb.host.fs.readText(join(dest, "dir/b.md"))).toBe("b\n");
    // --depth took effect, which it would not for a plain-path remote.
    expect(h.git(["rev-parse", "--is-shallow-repository"], { cwd: dest })).toBe("true");
    expect(h.git(["rev-parse", "HEAD"], { cwd: dest })).toBe(head);
  });

  it("maps bitbucket.org too, and honours a blobless filter", async () => {
    const { sb, h } = await setup();
    const remote = h.createRepo("bitbucket.org", "ws/repo");
    const head = remote.commit({ "SKILL.md": "x\n" });

    const dest = join(sb.root, "probe");
    const res = await sb.host.proc.run(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "-b", "main", remote.https, dest],
      {},
    );
    expect(res.code).toBe(0);
    expect(h.git(["config", "remote.origin.promisor"], { cwd: dest })).toBe("true");
    expect(h.git(["rev-parse", "HEAD"], { cwd: dest })).toBe(head);
  });

  it("refuses unmapped URLs without touching the network", async () => {
    const { sb, h } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "a\n" });

    for (const url of [remote.ssh, "https://gitlab.com/o/r.git", "http://github.com/o/r.git"]) {
      const res = await sb.host.proc.run("git", ["clone", "--depth", "1", url, join(sb.root, "x")], {});
      expect(res.code, url).not.toBe(0);
      expect(res.stderr, url).toMatch(/transport '(ssh|https|http)' not allowed/);
    }
  });

  it("commits trees and moves branches", async () => {
    const { h } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    const first = remote.commit({ "a.md": "a\n", "b.md": "b\n" });
    const second = remote.commit({ "b.md": null, "c.md": "c\n" }, { message: "second" });
    expect(h.git(["ls-tree", "--name-only", "-r", second], { cwd: remote.path }).split("\n")).toEqual(["a.md", "c.md"]);
    expect(h.git(["log", "-1", "--format=%s", second], { cwd: remote.path })).toBe("second");

    const feature = remote.commit({ "f.md": "f\n" }, { branch: "feature/main" });
    expect(h.git(["rev-list", "--count", feature], { cwd: remote.path })).toBe("1");
    expect(remote.head("feature/main")).toBe(feature);

    remote.setBranch("main", first);
    expect(remote.head()).toBe(first);
    expect(h.git(["ls-remote", remote.https, "refs/heads/main"])).toBe(`${first}\trefs/heads/main`);
  });
});
