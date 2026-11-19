import { createLibrary, type Library } from "@loadout/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { createGitHarness, createSandbox, demoRepo, demoRepoContent, seedDemo, type Remote } from "../src/index.ts";

function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The demo repo as tools/demo-repo.ts lays it out, as a local bare repo the sandbox maps its URL to. */
function demoRemote(git: ReturnType<typeof createGitHarness>): { remote: Remote; v1: string; v2: string } {
  const remote = git.createRepo("github.com", demoRepo.replace("https://github.com/", ""));
  const { main, ahead } = demoRepoContent();
  const v1 = remote.commit(main, { message: "Add the demo team catalog" });
  remote.setBranch("ahead", v1);
  const v2 = remote.commit(ahead, { branch: "ahead", message: "release-notes: breaking changes first" });
  for (const [tag, oid] of [["demo-stale-v1", v1], ["demo-stale-v2", v2]]) git.git(["update-ref", `refs/tags/${tag}`, oid!], { cwd: remote.path });
  git.git(["update-ref", "-d", "refs/heads/ahead"], { cwd: remote.path });
  // As if a previous seed had left it at v2.
  remote.setBranch("demo-stale", v2);
  return { remote, v1, v2 };
}

async function seeded(): Promise<{ library: Library; remote: Remote; v2: string }> {
  const sandbox = await createSandbox(onTestFinished);
  const { remote, v2 } = demoRemote(createGitHarness(sandbox));
  await seedDemo(sandbox.host);
  return { library: createLibrary(sandbox.host), remote, v2 };
}

describe("seedDemo", () => {
  it("leaves a copy in every state the app draws, as list and show report them", async () => {
    const { library, remote, v2 } = await seeded();

    // The winning copy of each name, with its remote checked so a moved source reads stale.
    const winners = must(await library.list({ checkRemote: true })).filter((e) => e.overriddenBy === null);
    const byName = Object.fromEntries(winners.map((e) => [e.name, e]));
    expect(Object.fromEntries(winners.map((e) => [e.name, e.state]))).toEqual({
      "commit-message": "not_installed",
      "explain-errors": "installed",
      standup: "installed",
      "code-review": "drifted",
      "release-notes": "stale",
      "test-first": "not_installed",
      "pr-description": "unmanaged",
      "security-reviewer": "installed",
    });
    expect(byName["explain-errors"]!.disabled).toBe(true);
    expect(byName["commit-message"]).toMatchObject({ catalog: "team", pinned: true });
    expect(must(await library.catalogs()).map((c) => [c.id, c.kind, c.writeMode])).toEqual([
      ["personal", "local", "local"],
      ["team", "remote", "pr"],
    ]);

    expect(must(await library.show("code-review")).entry.state).toBe("drifted");
    expect(must(await library.show("pr-description")).entry.state).toBe("unmanaged");
    expect(must(await library.show("explain-errors")).entry).toMatchObject({ state: "installed", disabled: true });
    // In resolution order: the pin puts team's copy first, over personal's precedence.
    expect(must(await library.show("commit-message")).copies).toMatchObject([
      { catalog: "team", wins: true, pinned: true },
      { catalog: "personal", wins: false },
    ]);
    // Installed through the core, so each installed copy has its receipt.
    for (const name of ["code-review", "release-notes", "security-reviewer", "standup", "explain-errors"]) {
      expect(must(await library.show(name)).installs, name).toHaveLength(1);
    }
    expect(must(await library.show("pr-description")).installs).toEqual([]);
    expect(must(await library.pins())).toMatchObject([{ name: "commit-message", catalog: "team" }]);
    expect(must(await library.accounts())).toEqual({});

    // The seed moved demo-stale back to v1 for the install and on to v2 after.
    expect(remote.head("demo-stale")).toBe(v2);
    expect(remote.head("main")).not.toBe(v2);
  });
});
