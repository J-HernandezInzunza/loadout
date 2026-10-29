import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { AuditEvent } from "@loadout/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "./audit.ts";
import { createTauriProc } from "./proc.ts";

type ShellEvent = { event: "Stdout" | "Stderr"; payload: string } | { event: "Terminated"; payload: { code: number | null; signal: number | null } };
type Spawned = { program: string; args: string[]; options: Record<string, unknown>; send: (e: ShellEvent) => void };

/**
 * The shell plugin behind mockIPC: `script` plays each spawned child (stream lines, then terminate), or
 * returns "hang" to leave it running until killed; a kill ends it as SIGKILL does.
 */
function mockShell(script: (child: Spawned) => "hang" | void) {
  const spawned: Spawned[] = [];
  const kills: number[] = [];
  mockIPC((cmd, payload) => {
    const a = payload as Record<string, unknown>;
    if (cmd === "plugin:shell|spawn") {
      const channel = a.onEvent as Channel<ShellEvent>;
      const child: Spawned = { program: a.program as string, args: a.args as string[], options: a.options as Record<string, unknown>, send: (e) => channel.onmessage(e) };
      spawned.push(child);
      const pid = spawned.length;
      // After spawn resolves, as the plugin's reader threads would.
      setTimeout(() => script(child), 0);
      return pid;
    }
    if (cmd === "plugin:shell|kill") {
      kills.push(a.pid as number);
      spawned[(a.pid as number) - 1]!.send({ event: "Terminated", payload: { code: null, signal: 9 } });
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return { spawned, kills };
}

afterEach(() => clearMocks());

describe("host-tauri proc", () => {
  it("runs git with cwd, env and its own process group, collecting both streams line by line", async () => {
    const shell = mockShell((c) => {
      c.send({ event: "Stdout", payload: "abc123\trefs/heads/main\n" });
      c.send({ event: "Stderr", payload: "warning: x\n" });
      c.send({ event: "Stdout", payload: "def456\trefs/heads/dev\n" });
      c.send({ event: "Terminated", payload: { code: 0, signal: null } });
    });
    const result = await createTauriProc(() => {}).run("git", ["ls-remote", "origin"], { cwd: "/repo", env: { GIT_TERMINAL_PROMPT: "0" } });
    expect(result).toEqual({ code: 0, stdout: "abc123\trefs/heads/main\ndef456\trefs/heads/dev\n", stderr: "warning: x\n", durationMs: expect.any(Number) });
    expect(shell.spawned[0]).toMatchObject({
      program: "git",
      args: ["ls-remote", "origin"],
      options: { cwd: "/repo", env: { GIT_TERMINAL_PROMPT: "0" }, processGroup: true },
    });
  });

  it("resolves a failing git with its exit code", async () => {
    mockShell((c) => {
      c.send({ event: "Stderr", payload: "fatal: not a git repository\n" });
      c.send({ event: "Terminated", payload: { code: 128, signal: null } });
    });
    expect(await createTauriProc(() => {}).run("git", ["status"], {})).toMatchObject({ code: 128, stderr: "fatal: not a git repository\n" });
  });

  it("a timeout kills the child, which ends as SIGKILL (137)", async () => {
    const shell = mockShell(() => "hang");
    const result = await createTauriProc(() => {}).run("git", ["fetch"], { timeoutMs: 20 });
    expect(shell.kills).toEqual([1]);
    expect(result).toMatchObject({ code: 137 });
  });

  it("an abort kills the child and rejects with AbortError; an aborted signal never spawns", async () => {
    const shell = mockShell(() => "hang");
    const proc = createTauriProc(() => {});
    const controller = new AbortController();
    const run = proc.run("git", ["clone", "x"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(shell.kills).toEqual([1]);

    await expect(proc.run("git", ["fetch"], { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(shell.spawned).toHaveLength(1);
  });

  it("audits each run's start and end, and never an env value", async () => {
    mockShell((c) => c.send({ event: "Terminated", payload: { code: 0, signal: null } }));
    const log = createAuditLog();
    await createTauriProc(log.record).run("git", ["push", "origin", "HEAD:main"], { cwd: "/repo", env: { LOADOUT_GIT_TOKEN: "s3cret-token" } });
    expect(log.events()).toEqual([
      { kind: "proc:start", id: 1, argv: ["git", "push", "origin", "HEAD:main"], cwd: "/repo" },
      { kind: "proc:end", id: 1, code: 0, durationMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(log.events())).not.toContain("s3cret-token");
  });
});

describe("audit log", () => {
  it("keeps the most recent events, oldest first, and tells subscribers about new ones", () => {
    const log = createAuditLog(2);
    const seen: AuditEvent[] = [];
    const unsubscribe = log.subscribe((e) => seen.push(e));
    const fsEvent = (path: string): AuditEvent => ({ kind: "fs", op: "delete", path });
    log.record(fsEvent("/a"));
    log.record(fsEvent("/b"));
    log.record(fsEvent("/c"));
    expect(log.events()).toEqual([fsEvent("/b"), fsEvent("/c")]);
    unsubscribe();
    log.record(fsEvent("/d"));
    expect(seen).toEqual([fsEvent("/a"), fsEvent("/b"), fsEvent("/c")]);
  });
});
