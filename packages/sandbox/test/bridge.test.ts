import { createLibrary, type AuditEvent, type Host } from "@loadout/core";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createBridgeHost, fetchSession } from "../src/bridge/client.ts";
import { fromWire, toWire } from "../src/bridge/protocol.ts";
import { createDemoServer, type DemoServer } from "../src/bridge/server.ts";

/** The demo server's middleware mounted at /__demo on a loopback server, as the Vite plugin mounts it. */
async function serve(demo: DemoServer): Promise<string> {
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/__demo/")) return void res.writeHead(404).end();
    req.url = req.url.slice("/__demo".length);
    demo.middleware(req, res, () => res.writeHead(404).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/__demo`;
}

async function bridged() {
  const demo = await createDemoServer();
  onTestFinished(() => demo.close());
  const base = await serve(demo);
  const session = await fetchSession(base);
  const audit: AuditEvent[] = [];
  const host = createBridgeHost(base, session.paths, (e) => audit.push(e));
  return { demo, base, session, host, audit };
}

/** A loopback server that never answers, for aborts and timeouts. */
async function silentServer(): Promise<{ url: string; closed: Promise<void> }> {
  let closed!: () => void;
  const seen = new Promise<void>((resolve) => (closed = resolve));
  const server = createServer((req) => req.on("close", closed));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, closed: seen };
}

/** A Node error's code, else the name (a DOMException's numeric `code` is its legacy constant). */
const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: { name: string; code?: unknown }) => (typeof e.code === "string" ? e.code : e.name));

describe("bridge host", () => {
  it("round-trips every fs call through the demo server", async () => {
    const { host, demo, session } = await bridged();
    const home = session.paths.home;
    expect(home).toBe(join(demo.root(), "home"));

    const dir = join(home, "work");
    await host.fs.mkdirp(dir);
    await host.fs.writeTextAtomic(join(dir, "a.md"), "café\n");
    expect(await host.fs.readText(join(dir, "a.md"))).toBe("café\n");
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await host.fs.writeBytes(join(dir, "b.bin"), bytes, { mode: 0o755 });
    expect(await host.fs.readBytes(join(dir, "b.bin"))).toEqual(bytes);
    expect(await host.fs.exists(join(dir, "b.bin"))).toBe(true);
    expect(await host.fs.exists(join(dir, "nope"))).toBe(false);
    expect(await host.fs.stat(join(dir, "b.bin"))).toMatchObject({ kind: "file", size: 256, mode: expect.any(Number) });
    expect((await host.fs.stat(join(dir, "b.bin"))).mode & 0o777).toBe(0o755);
    expect(await host.fs.lstat(dir)).toMatchObject({ kind: "dir" });
    expect(await host.fs.realPath(join(dir, "..", "work", "a.md"))).toBe(join(dir, "a.md"));
    await host.fs.copyFile(join(dir, "a.md"), join(dir, "c.md"));
    await host.fs.rename(join(dir, "c.md"), join(dir, "d.md"));
    expect((await host.fs.readDir(dir)).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a.md", kind: "file" },
      { name: "b.bin", kind: "file" },
      { name: "d.md", kind: "file" },
    ]);
    await host.fs.remove(join(dir, "d.md"));
    expect(await host.fs.makeTempDir("op-")).toMatch(join(session.paths.appData, "tmp", "op-"));
    await host.fs.remove(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("round-trips proc, secrets and http, and sends the server's git runs to the browser's audit", async () => {
    const { host, session, audit } = await bridged();

    const git = await host.proc.which("git");
    expect(git).toMatch(/\/git$/);
    const run = await host.proc.run("git", ["--version"], { cwd: session.paths.home });
    expect(run).toMatchObject({ code: 0, stdout: expect.stringMatching(/^git version/) });
    expect(audit).toMatchObject([
      { kind: "proc:start", argv: ["git", "--version"], cwd: session.paths.home },
      { kind: "proc:end", code: 0 },
    ]);

    await host.secrets.set("k", "v");
    expect(await host.secrets.get("k")).toBe("v");
    await host.secrets.delete("k");
    expect(await host.secrets.get("k")).toBeNull();

    // The seed connected GitHub, so its token answers on the stub.
    const res = await host.http.request({ method: "GET", url: `${session.apiBases.github}/user`, headers: { authorization: "Bearer demo-token" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ login: "acme-dev" });
  });

  it("keeps a rejection's name and code: ENOENT, AbortError, TimeoutError, and EXDEV across the wire format", async () => {
    const { host, session } = await bridged();
    expect(await code(host.fs.readText(join(session.paths.home, "missing")))).toBe("ENOENT");
    expect(await code(host.fs.realPath(join(session.paths.home, "missing")))).toBe("ENOENT");

    const timeout = await silentServer();
    expect(await code(host.http.request({ method: "GET", url: timeout.url, timeoutMs: 100 }))).toBe("TimeoutError");

    const abort = await silentServer();
    const controller = new AbortController();
    const pending = host.http.request({ method: "GET", url: abort.url, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await code(pending)).toBe("AbortError");
    // The server aborted its own request too, rather than leaving it hanging.
    await abort.closed;

    // A rename across volumes can't happen inside one temp folder, so EXDEV is checked on the codec.
    const exdev = fromWire(toWire(Object.assign(new Error("cross-device link"), { code: "EXDEV" })));
    expect(exdev).toMatchObject({ code: "EXDEV", message: "cross-device link" });
  });

  it("refuses a path outside the sandbox root, and a call that isn't a Host method", async () => {
    const { host, base } = await bridged();
    await expect(host.fs.readText("/etc/hosts")).rejects.toThrow(/escapes the sandbox/);
    await expect(host.proc.run("git", ["status"], { cwd: "/" })).rejects.toThrow(/escapes the sandbox/);
    const res = await fetch(`${base}/host`, { method: "POST", body: JSON.stringify({ method: "fs.chmod", args: [] }) });
    expect(res.status).toBe(400);
  });

  it("answers loopback only", async () => {
    const demo = await createDemoServer();
    onTestFinished(() => demo.close());
    let status = 0;
    const res = { writeHead: (s: number) => ((status = s), res), end: () => res } as unknown as ServerResponse;
    demo.middleware({ socket: { remoteAddress: "10.0.0.2" }, url: "/session", method: "GET" } as IncomingMessage, res, () => {});
    expect(status).toBe(403);
  });

  it("reset replaces the sandbox with a freshly seeded one", async () => {
    const { demo, base, session: before } = await bridged();
    const host: Host = createBridgeHost(base, before.paths);
    await host.fs.remove(join(before.paths.home, ".claude", "skills", "code-review"), { recursive: true });
    const oldRoot = demo.root();

    expect((await fetch(`${base}/reset`, { method: "POST" })).status).toBe(204);
    expect(existsSync(oldRoot)).toBe(false);
    const after = await fetchSession(base);
    expect(after.paths.home).not.toBe(before.paths.home);

    // The core, over the bridge, sees the seeded machine again.
    const library = createLibrary(createBridgeHost(base, after.paths), { apiBases: after.apiBases });
    const list = await library.list();
    if (!list.ok) throw new Error(list.error.message);
    const states = Object.fromEntries(list.value.filter((e) => e.overriddenBy === null).map((e) => [e.name, e.state]));
    expect(states).toMatchObject({ "code-review": "drifted", "pr-description": "unmanaged", "test-first": "not_installed" });
  });
});
