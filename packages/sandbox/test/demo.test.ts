import { createLibrary, type Library } from "@loadout/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { createApiStub, createSandbox, demoLogin, seedDemo } from "../src/index.ts";

function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function seeded(): Promise<Library> {
  const sandbox = await createSandbox(onTestFinished);
  const stub = await createApiStub(onTestFinished);
  await seedDemo(sandbox, stub);
  return createLibrary(sandbox.host, { apiBases: stub.bases });
}

describe("seedDemo", () => {
  it("leaves a copy in every state the app draws, as list and show report them", async () => {
    const library = await seeded();

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
    expect(must(await library.accounts()).github).toMatchObject({ login: demoLogin });
  });
});
