import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "./sandbox.ts";

describe("sandbox", () => {
  it("gives each sandbox its own temp root with home and appData", async () => {
    const a = await createSandbox();
    const b = await createSandbox();
    expect(a.root).not.toBe(b.root);
    expect(a.host.paths).toEqual({ home: join(a.root, "home"), appData: join(a.root, "appData") });
    expect(await a.host.fs.exists(a.host.paths.home)).toBe(true);
    expect(await a.host.fs.exists(a.host.paths.appData)).toBe(true);
  });

  it("serves fs calls inside the sandbox", async () => {
    const { host } = await createSandbox();
    const file = join(host.paths.home, "a.txt");
    await host.fs.writeTextAtomic(file, "x");
    await host.fs.copyFile(file, join(host.paths.appData, "b.txt"));
    expect(await host.fs.readText(join(host.paths.appData, "b.txt"))).toBe("x");
    expect(await host.fs.makeTempDir("op-")).toMatch(join(host.paths.appData, "tmp", "op-"));
  });

  it("rejects and records fs calls whose paths escape", async () => {
    const sb = await createSandbox();
    await expect(sb.host.fs.readText(join(sb.root, "..", "elsewhere"))).rejects.toThrow(/escapes the sandbox/);
    await expect(sb.host.fs.exists("home/a.txt")).rejects.toThrow(/escapes the sandbox/);
    // An op that swallows the rejection still fails the test when the sandbox is verified.
    await sb.host.fs.copyFile(join(sb.host.paths.home, "a"), "/etc/hosts").catch(() => {});
    expect(() => sb.verify()).toThrow(/3 calls escaped the sandbox/);
    expect(() => sb.verify()).not.toThrow();
  });

  it("rejects a process whose cwd escapes, and runs one without a cwd at the root", async () => {
    const sb = await createSandbox();
    await expect(sb.host.proc.run("git", ["--version"], { cwd: "/" })).rejects.toThrow(/escapes the sandbox/);
    expect(() => sb.verify()).toThrow(/1 call escaped the sandbox/);
    expect((await sb.host.proc.run("git", ["--version"], {})).code).toBe(0);
    expect(sb.audit[0]).toMatchObject({ kind: "proc:start", argv: ["git", "--version"], cwd: sb.root });
  });

  it("rejects and records HTTP requests off loopback", async () => {
    const sb = await createSandbox();
    await expect(sb.host.http.request({ method: "GET", url: "https://api.github.com/user" })).rejects.toThrow(
      /leaves loopback/,
    );
    expect(() => sb.verify()).toThrow(/1 call escaped the sandbox:\nhttp.request: https:\/\/api.github.com\/user/);
  });

  it.fails("fails the test when an escape was never verified", async () => {
    const sb = await createSandbox();
    await sb.host.fs.readText("/etc/hosts").catch(() => {});
  });

  let root = "";
  it("keeps the temp root while the test runs", async () => {
    root = (await createSandbox()).root;
    expect(existsSync(root)).toBe(true);
  });

  it("removes the temp root after the test", () => {
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });
});
