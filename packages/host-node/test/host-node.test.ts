import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Host } from "@loadout/core";
import { createNodeHost } from "../src/index.ts";

let root: string;
let host: Host;
let events: AuditEvent[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loadout-host-node-"));
  events = [];
  host = createNodeHost({
    home: join(root, "home"),
    appData: join(root, "appdata"),
    onAudit: (e) => events.push(e),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fs", () => {
  it("writeTextAtomic replaces the file and leaves no temp file behind", async () => {
    const p = join(root, "a.json");
    await writeFile(p, "old");
    await host.fs.writeTextAtomic(p, "new");
    expect(await readFile(p, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["a.json"]);
  });

  it("writeTextAtomic keeps the existing file's mode", async () => {
    const p = join(root, "a.sh");
    await writeFile(p, "x", { mode: 0o755 });
    await host.fs.writeTextAtomic(p, "y");
    expect((await stat(p)).mode & 0o777).toBe(0o755);
  });

  it("writeBytes applies the requested mode", async () => {
    const p = join(root, "bin");
    await host.fs.writeBytes(p, new Uint8Array([1, 2]), { mode: 0o700 });
    expect(await host.fs.readBytes(p)).toEqual(new Uint8Array([1, 2]));
    expect((await stat(p)).mode & 0o777).toBe(0o700);
  });

  it("realPath resolves every symlink in the path", async () => {
    await host.fs.mkdirp(join(root, "tool", "skill"));
    await symlink(join(root, "tool"), join(root, "link"));
    const real = await host.fs.realPath(join(root, "tool"));
    expect(await host.fs.realPath(join(root, "link", "skill"))).toBe(join(real, "skill"));
    await expect(host.fs.realPath(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stat follows symlinks and lstat does not", async () => {
    await host.fs.mkdirp(join(root, "d"));
    await symlink(join(root, "d"), join(root, "link"));
    expect((await host.fs.stat(join(root, "link"))).kind).toBe("dir");
    expect((await host.fs.lstat(join(root, "link"))).kind).toBe("symlink");
  });

  it("readDir reports each entry's kind without following links", async () => {
    await host.fs.mkdirp(join(root, "d"));
    await writeFile(join(root, "f"), "");
    await symlink(join(root, "d"), join(root, "l"));
    const entries = await host.fs.readDir(root);
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "d", kind: "dir" },
      { name: "f", kind: "file" },
      { name: "l", kind: "symlink" },
    ]);
  });

  it("exists is false for a missing path and true for a dangling symlink", async () => {
    expect(await host.fs.exists(join(root, "nope"))).toBe(false);
    await symlink(join(root, "nope"), join(root, "dangling"));
    expect(await host.fs.exists(join(root, "dangling"))).toBe(true);
  });

  it("remove deletes a tree only when recursive", async () => {
    await host.fs.mkdirp(join(root, "t/u"));
    await expect(host.fs.remove(join(root, "t"))).rejects.toThrow();
    await host.fs.remove(join(root, "t"), { recursive: true });
    expect(await host.fs.exists(join(root, "t"))).toBe(false);
  });

  it("rename rejections carry the errno code", async () => {
    await expect(host.fs.rename(join(root, "missing"), join(root, "x"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("makeTempDir creates a fresh directory under <appData>/tmp", async () => {
    const a = await host.fs.makeTempDir("op-");
    const b = await host.fs.makeTempDir("op-");
    expect(a).not.toBe(b);
    expect(a.startsWith(join(root, "appdata", "tmp", "op-"))).toBe(true);
    expect((await stat(a)).isDirectory()).toBe(true);
  });
});

describe("proc", () => {
  // A git alias that shells out to sleep: a slow git process without touching the network.
  const SLEEP = ["-c", "alias.slow=!sleep 10", "slow"];

  it("gives the child no stdin, so git can never wait on a prompt", async () => {
    const r = await host.proc.run("git", ["hash-object", "--stdin"], { cwd: root, timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("returns stdout and exit code and audits start and end", async () => {
    const r = await host.proc.run("git", ["--version"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
    expect(events).toEqual([
      { kind: "proc:start", id: 1, argv: ["git", "--version"], cwd: root },
      { kind: "proc:end", id: 1, code: 0, durationMs: r.durationMs },
    ]);
  });

  it("returns a non-zero exit code instead of throwing", async () => {
    const r = await host.proc.run("git", ["rev-parse", "HEAD"], { cwd: root });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a git repository/);
  });

  it("passes env on top of the inherited environment", async () => {
    const r = await host.proc.run("git", ["config", "--get", "user.name"], {
      cwd: root,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "x" },
    });
    expect(r.code).toBe(1);
  });

  it("kills the process when the timeout elapses", async () => {
    const r = await host.proc.run("git", SLEEP, { cwd: root, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it("rejects with ENOENT when the program is not on PATH, and still closes the audit pair", async () => {
    await expect(host.proc.run("git", ["--version"], { env: { PATH: "/nonexistent" } })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(events.map((e) => e.kind)).toEqual(["proc:start", "proc:end"]);
  });

  it("rejects with AbortError when the signal aborts", async () => {
    const ac = new AbortController();
    const p = host.proc.run("git", SLEEP, { cwd: root, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("secrets", () => {
  it("stores, reads and deletes values; a missing key reads as null", async () => {
    expect(await host.secrets.get("github.com")).toBeNull();
    await host.secrets.set("github.com", "tok-1");
    await host.secrets.set("github.com", "tok-2");
    expect(await host.secrets.get("github.com")).toBe("tok-2");
    await host.secrets.delete("github.com");
    await host.secrets.delete("github.com");
    expect(await host.secrets.get("github.com")).toBeNull();
  });

  it("keeps one store per host instance", async () => {
    const other = createNodeHost({ home: join(root, "home"), appData: join(root, "appdata") });
    await host.secrets.set("bitbucket.org", "tok");
    expect(await other.secrets.get("bitbucket.org")).toBeNull();
  });
});

describe("http", () => {
  let server: Server;
  let base: string;
  let received: { method: string; url: string; headers: Record<string, unknown>; body: string }[];

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8").on("data", (d: string) => (body += d));
      req.on("end", () => {
        received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        // /slow never answers; the client has to give up.
        if (req.url === "/slow") return;
        res.writeHead(201, { "Content-Type": "application/json", "X-Request-Id": "r1" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends method, headers and body, and returns status, lowercased headers and body", async () => {
    const res = await host.http.request({
      method: "POST",
      url: `${base}/repos/o/r/pulls`,
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: '{"title":"x"}',
    });
    expect(res.status).toBe(201);
    expect(res.headers).toMatchObject({ "content-type": "application/json", "x-request-id": "r1" });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(received).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/repos/o/r/pulls",
        headers: expect.objectContaining({ authorization: "Bearer t" }),
        body: '{"title":"x"}',
      }),
    ]);
  });

  it("rejects with TimeoutError when the timeout elapses", async () => {
    const started = Date.now();
    await expect(host.http.request({ method: "GET", url: `${base}/slow`, timeoutMs: 100 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects with AbortError when the signal aborts", async () => {
    const ac = new AbortController();
    const p = host.http.request({ method: "GET", url: `${base}/slow`, signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects at once when the signal is already aborted", async () => {
    await expect(
      host.http.request({ method: "GET", url: `${base}/`, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toEqual([]);
  });
});

describe("misc", () => {
  it("sha256 returns lowercase hex", async () => {
    expect(await host.sha256(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("exposes the configured paths", () => {
    expect(host.paths).toEqual({ home: join(root, "home"), appData: join(root, "appdata") });
  });
});
