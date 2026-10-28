import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHarness } from "../../test/git.ts";
import { createSandbox } from "../../test/sandbox.ts";
import type { Host } from "../host.ts";
import { createGitClient } from "./git.ts";
import { createOperation, repoKey, sweepTemp } from "./operation.ts";

async function setup() {
  const sb = await createSandbox();
  const h = createGitHarness(sb);
  const commands: string[][] = [];
  const host: Host = {
    ...sb.host,
    proc: {
      run(program, args, o) {
        commands.push(args);
        return sb.host.proc.run(program, args, o);
      },
    },
  };
  const git = createGitClient(host);
  const count = (cmd: string) => commands.filter((a) => a.includes(cmd)).length;
  return { sb, h, host, git, count, tmp: join(host.paths.appData, "tmp") };
}

const src = (repo: string, branch = "main") => ({ kind: "github" as const, org: "o", repo, branch });

describe("operation caches", () => {
  it("keys a repo+branch as <kind>:<org>/<repo>@<branch>", () => {
    expect(repoKey({ kind: "bitbucket", org: "ws", repo: "lib", branch: "dev" })).toBe("bitbucket:ws/lib@dev");
  });

  it("FETCH-04: two entries from one repo+branch clone once, another branch clones again", async () => {
    const { h, host, git, count } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "skills/a/SKILL.md": "a\n", "prompts/p.md": "p\n" });
    remote.commit({ "skills/a/SKILL.md": "dev\n" }, { branch: "dev" });
    const op = await createOperation(host, git);

    const [a, b] = await Promise.all([op.clones.checkout(src("r")), op.clones.checkout(src("r"))]);
    expect(a).toEqual(b);
    const dir = a.ok ? a.value : "";
    expect(dir.startsWith(op.dir + "/")).toBe(true);
    expect(readFileSync(join(dir, "skills/a/SKILL.md"), "utf8")).toBe("a\n");
    expect(count("clone")).toBe(2); // ssh refused, then https: one clone

    const dev = await op.clones.checkout(src("r", "dev"));
    expect(dev.ok && readFileSync(join(dev.value, "skills/a/SKILL.md"), "utf8")).toBe("dev\n");
    expect(count("clone")).toBe(4);
  });

  it("FETCH-04: a failed clone is reported once per operation", async () => {
    const { host, git, count } = await setup();
    const op = await createOperation(host, git);
    const first = await op.clones.checkout(src("missing"));
    expect(first).toMatchObject({ ok: false, error: { code: "GIT_FAILED" } });
    expect(await op.clones.checkout(src("missing"))).toEqual(first);
    expect(count("clone")).toBe(2); // ssh and https, once
  });

  it("probes a repo+branch once for every path asked, and memoizes a failed probe", async () => {
    const { h, host, git, count } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    const tip = remote.commit({ "skills/a/SKILL.md": "a\n", "prompts/p.md": "p\n" });
    const op = await createOperation(host, git);

    const skill = await op.probes.oid(src("r"), "skills/a");
    expect(skill).toEqual({ commit: tip, oid: h.git(["rev-parse", `${tip}:skills/a`], { cwd: remote.path }) });
    expect(await op.probes.oid(src("r"), "prompts/p.md")).toMatchObject({ commit: tip });
    expect(await op.probes.oid(src("r"), "skills/gone")).toBeNull();
    expect(count("clone")).toBe(2); // ssh refused, https once

    expect(await op.probes.oid(src("missing"), "x")).toBeNull();
    expect(await op.probes.oid(src("missing"), "y")).toBeNull();
    expect(count("clone")).toBe(4);
  });

  it("FETCH-09: each operation gets its own tmp/<op id>/, removed when it ends", async () => {
    const { sb, h, host, git, tmp } = await setup();
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "a\n" });
    const a = await createOperation(host, git);
    const b = await createOperation(host, git);
    expect(a.dir).not.toBe(b.dir);
    expect(a.dir.startsWith(tmp + "/")).toBe(true);

    await a.clones.checkout(src("r"));
    await a.probes.oid(src("r"), "a.md");
    await a.dispose();
    expect(await host.fs.exists(a.dir)).toBe(false);
    expect(await host.fs.exists(b.dir)).toBe(true);
    expect(sb.audit).toContainEqual({ kind: "fs", op: "delete", path: a.dir });
  });

  it("FETCH-09: the launch sweep removes what a killed operation left", async () => {
    const { h, host, git, tmp } = await setup();
    await sweepTemp(host); // no tmp dir yet: nothing to do
    const remote = h.createRepo("github.com", "o/r");
    remote.commit({ "a.md": "a\n" });
    const killed = await createOperation(host, git);
    await killed.clones.checkout(src("r"));

    await sweepTemp(host);
    expect(await host.fs.exists(killed.dir)).toBe(false);
    expect(await host.fs.readDir(tmp)).toEqual([]);
  });
});
