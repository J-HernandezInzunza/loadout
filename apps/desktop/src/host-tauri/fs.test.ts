import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { createTauriFs } from "./fs.ts";

type Node = { kind: "file"; data: Uint8Array; mode: number } | { kind: "dir"; mode: number } | { kind: "symlink"; target: string };
type Call = { cmd: string; args: unknown; headers?: Record<string, string> };

const oserr = (what: string, errno: number, text: string) => Promise.reject(`${what}: ${text} (os error ${errno})`);
const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/**
 * plugin-fs behind mockIPC, over an in-memory tree. mockIPC drops invoke's options, and the plugin sends a
 * write's path in them (headers), so the fake replaces invoke after mockIPC installs the internals.
 * Paths under /Volumes/ are another volume: a rename across is EXDEV, as on disk. `failRename` makes every
 * rename fail as a permission error would.
 */
function mockFs(seed: Record<string, Node> = {}, opts: { failRename?: boolean } = {}) {
  const tree = new Map<string, Node>([["/", { kind: "dir", mode: 0o40755 }], ...Object.entries(seed)]);
  const calls: Call[] = [];
  const follow = (p: string): string => {
    const n = tree.get(p);
    return n?.kind === "symlink" ? follow(n.target) : p;
  };
  const info = (n: Node) => ({
    isFile: n.kind === "file",
    isDirectory: n.kind === "dir",
    isSymlink: n.kind === "symlink",
    size: n.kind === "file" ? n.data.length : 0,
    mtime: null,
    atime: null,
    birthtime: null,
    mode: n.kind === "symlink" ? 0o120755 : n.mode,
  });
  const write = (path: string, data: Uint8Array, options: { mode?: number } | undefined) => {
    if (tree.get(parent(path))?.kind !== "dir") return oserr("failed to open file", 2, "No such file or directory");
    const old = tree.get(path);
    tree.set(path, { kind: "file", data, mode: old?.kind === "file" ? old.mode : 0o100000 | (options?.mode ?? 0o644) });
    return null;
  };

  const handle = (cmd: string, a: Record<string, unknown>, headers?: Record<string, string>): unknown => {
    const path = a.path as string;
    switch (cmd) {
      case "plugin:fs|read_text_file":
      case "plugin:fs|read_file": {
        const n = tree.get(follow(path));
        // An array, not an ArrayBuffer: jsdom's ArrayBuffer is another realm's, so the plugin's instanceof check would miss it.
        return n?.kind === "file" ? Array.from(n.data) : oserr("failed to open file", 2, "No such file or directory");
      }
      case "plugin:fs|write_text_file":
      case "plugin:fs|write_file":
        return write(decodeURIComponent(headers!.path!), a as unknown as Uint8Array, JSON.parse(headers!.options ?? "null") ?? undefined);
      case "plugin:fs|stat":
      case "plugin:fs|lstat": {
        const n = tree.get(cmd === "plugin:fs|stat" ? follow(path) : path);
        return n ? info(n) : oserr("failed to get metadata", 2, "No such file or directory");
      }
      case "plugin:fs|read_dir":
        return [...tree.entries()]
          .filter(([p]) => p !== path && parent(p) === path)
          .map(([p, n]) => ({ name: p.slice(path.length + 1), isFile: n.kind === "file", isDirectory: n.kind === "dir", isSymlink: n.kind === "symlink" }));
      case "plugin:fs|mkdir": {
        const parts = path.split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          const p = `/${parts.slice(0, i).join("/")}`;
          if (!tree.has(p)) tree.set(p, { kind: "dir", mode: 0o40755 });
        }
        return null;
      }
      case "plugin:fs|rename": {
        const [from, to] = [a.oldPath as string, a.newPath as string];
        if (opts.failRename) return oserr("failed to rename", 13, "Permission denied");
        if (from.startsWith("/Volumes/") !== to.startsWith("/Volumes/")) return oserr("failed to rename", 18, "Cross-device link");
        if (!tree.has(from)) return oserr("failed to rename", 2, "No such file or directory");
        for (const [p, n] of [...tree]) {
          if (p === from || p.startsWith(`${from}/`)) {
            tree.delete(p);
            tree.set(to + p.slice(from.length), n);
          }
        }
        return null;
      }
      case "plugin:fs|copy_file": {
        const n = tree.get(follow(a.fromPath as string));
        return n?.kind === "file" ? (tree.set(a.toPath as string, { ...n }), null) : oserr("failed to copy", 2, "No such file or directory");
      }
      case "plugin:fs|remove":
        for (const p of [...tree.keys()]) if (p === path || p.startsWith(`${path}/`)) tree.delete(p);
        return null;
      case "real_path":
        return tree.has(follow(path)) ? follow(path) : oserr("failed", 2, "No such file or directory");
    }
    throw new Error(`unexpected command ${cmd}`);
  };

  mockIPC(() => null);
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  internals.invoke = async (cmd: string, args: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
    calls.push({ cmd, args, ...(options?.headers && { headers: options.headers }) });
    return handle(cmd, args, options?.headers);
  };
  const text = (p: string) => {
    const n = tree.get(p);
    return n?.kind === "file" ? new TextDecoder().decode(n.data) : undefined;
  };
  return { tree, calls, text, cmds: () => calls.map((c) => c.cmd.replace("plugin:fs|", "")) };
}

const file = (text: string, mode = 0o100644): Node => ({ kind: "file", data: new TextEncoder().encode(text), mode });
const dir = (): Node => ({ kind: "dir", mode: 0o40755 });
const appData = "/home/u/Library/Application Support/loadout";

afterEach(() => clearMocks());

describe("host-tauri fs", () => {
  it("readText and readBytes read through the plugin; a missing file rejects with ENOENT", async () => {
    const m = mockFs({ "/home": dir(), "/home/a.md": file("hi\n") });
    const fs = createTauriFs(appData);
    expect(await fs.readText("/home/a.md")).toBe("hi\n");
    expect(Array.from(await fs.readBytes("/home/a.md"))).toEqual([104, 105, 10]);
    await expect(fs.readText("/home/none.md")).rejects.toMatchObject({ code: "ENOENT" });
    expect(m.calls[0]).toEqual({ cmd: "plugin:fs|read_text_file", args: { path: "/home/a.md" } });
  });

  it("writeTextAtomic writes a temp file in the same dir with the old mode, then renames it over the target", async () => {
    const m = mockFs({ "/home": dir(), "/home/c.json": file("old", 0o100600) });
    await createTauriFs(appData).writeTextAtomic("/home/c.json", "new");
    expect(m.text("/home/c.json")).toBe("new");
    expect([...m.tree.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
    const write = m.calls.find((c) => c.cmd === "plugin:fs|write_text_file")!;
    const tmp = decodeURIComponent(write.headers!.path!);
    expect(tmp).toMatch(/^\/home\/\.c\.json\.[0-9a-f-]+\.tmp$/);
    expect(JSON.parse(write.headers!.options!)).toEqual({ mode: 0o600 });
    expect(m.calls.find((c) => c.cmd === "plugin:fs|rename")!.args).toEqual({ oldPath: tmp, newPath: "/home/c.json" });
  });

  it("writeTextAtomic removes its temp file and leaves the target alone when the rename fails", async () => {
    const m = mockFs({ "/home": dir(), "/home/c.json": file("old") }, { failRename: true });
    await expect(createTauriFs(appData).writeTextAtomic("/home/c.json", "new")).rejects.toThrow("Permission denied (os error 13)");
    expect(m.text("/home/c.json")).toBe("old");
    expect([...m.tree.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  it("writeTextAtomic into a missing dir rejects with ENOENT", async () => {
    mockFs({ "/home": dir() });
    await expect(createTauriFs(appData).writeTextAtomic("/home/missing/c.json", "new")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writeBytes passes the mode on create", async () => {
    const m = mockFs({ "/home": dir() });
    await createTauriFs(appData).writeBytes("/home/run.sh", new TextEncoder().encode("#!"), { mode: 0o755 });
    expect(m.tree.get("/home/run.sh")).toMatchObject({ kind: "file", mode: 0o100755 });
    expect(JSON.parse(m.calls[0]!.headers!.options!)).toEqual({ mode: 0o755 });
  });

  it("stat follows a symlink, lstat doesn't, and exists is true for a dangling link", async () => {
    mockFs({ "/home": dir(), "/home/real": dir(), "/home/link": { kind: "symlink", target: "/home/real" }, "/home/dangling": { kind: "symlink", target: "/home/gone" } });
    const fs = createTauriFs(appData);
    expect(await fs.stat("/home/link")).toEqual({ kind: "dir", size: 0, mode: 0o40755 });
    expect(await fs.lstat("/home/link")).toMatchObject({ kind: "symlink" });
    expect(await fs.exists("/home/dangling")).toBe(true);
    expect(await fs.exists("/home/nothing")).toBe(false);
    await expect(fs.stat("/home/dangling")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("realPath resolves links through the real_path command, and rejects ENOENT when missing", async () => {
    const m = mockFs({ "/home": dir(), "/home/real": dir(), "/home/link": { kind: "symlink", target: "/home/real" } });
    const fs = createTauriFs(appData);
    expect(await fs.realPath("/home/link")).toBe("/home/real");
    expect(m.calls.at(-1)).toEqual({ cmd: "real_path", args: { path: "/home/link" } });
    await expect(fs.realPath("/home/none")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("readDir reports each entry's kind, a symlink as a symlink", async () => {
    mockFs({ "/home": dir(), "/home/s": dir(), "/home/f.md": file("x"), "/home/l": { kind: "symlink", target: "/home/s" } });
    const entries = await createTauriFs(appData).readDir("/home");
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "f.md", kind: "file" },
      { name: "l", kind: "symlink" },
      { name: "s", kind: "dir" },
    ]);
  });

  it("rename rejects with EXDEV across volumes", async () => {
    mockFs({ "/home": dir(), "/home/a": file("x"), "/Volumes/ext": dir() });
    const fs = createTauriFs(appData);
    await expect(fs.rename("/home/a", "/Volumes/ext/a")).rejects.toMatchObject({ code: "EXDEV" });
    await fs.rename("/home/a", "/home/b");
    expect(await fs.exists("/home/b")).toBe(true);
  });

  it("mkdirp, copyFile and remove go through the plugin with the right options", async () => {
    const m = mockFs({ "/home": dir(), "/home/a": file("x") });
    const fs = createTauriFs(appData);
    await fs.mkdirp("/home/d/e");
    await fs.copyFile("/home/a", "/home/d/e/a");
    await fs.remove("/home/d", { recursive: true });
    await fs.remove("/home/a");
    expect(m.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["plugin:fs|mkdir", { path: "/home/d/e", options: { recursive: true } }],
      ["plugin:fs|copy_file", { fromPath: "/home/a", toPath: "/home/d/e/a" }],
      ["plugin:fs|remove", { path: "/home/d", options: { recursive: true } }],
      ["plugin:fs|remove", { path: "/home/a" }],
    ]);
    expect([...m.tree.keys()]).toEqual(["/", "/home"]);
  });

  it("makeTempDir creates a fresh dir under <appData>/tmp", async () => {
    const m = mockFs({});
    const fs = createTauriFs(appData);
    const a = await fs.makeTempDir("op-");
    const b = await fs.makeTempDir("op-");
    expect(a).toMatch(new RegExp(`^${appData}/tmp/op-[0-9a-f]{8}$`));
    expect(a).not.toBe(b);
    expect(m.tree.get(a)).toMatchObject({ kind: "dir" });
  });
});
