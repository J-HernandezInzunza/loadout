// HostFs over @tauri-apps/plugin-fs (architecture.md §2.2, §2.4). The plugin has no realpath, so realPath
// goes through the app's real_path command (QUESTIONS.md Q6). Plugin errors arrive as strings; the two
// codes the core branches on, ENOENT and EXDEV, come back as `{ code }` errors, as Node's do.
import { invoke } from "@tauri-apps/api/core";
import * as fs from "@tauri-apps/plugin-fs";
import type { FileKind, HostFs } from "@loadout/core";

// macOS errno values in Rust's io::Error text, "… (os error 18)".
const codes: Record<string, string> = { "2": "ENOENT", "18": "EXDEV" };

function hostError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const code = codes[/\(os error (\d+)\)/.exec(message)?.[1] ?? ""];
  return Object.assign(new Error(message), code !== undefined && { code });
}

/** `f` with plugin errors turned into host errors. */
function mapped<A extends unknown[], R>(f: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => f(...args).catch((e: unknown) => Promise.reject(hostError(e)));
}

function kindOf(e: { isSymlink: boolean; isDirectory: boolean }): FileKind {
  if (e.isSymlink) return "symlink";
  return e.isDirectory ? "dir" : "file";
}

const describe = (info: fs.FileInfo) => ({ kind: kindOf(info), size: info.size, mode: info.mode ?? 0 });
const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function createTauriFs(appData: string): HostFs {
  const lstat = mapped(async (path: string) => describe(await fs.lstat(path)));
  const rename = mapped((from: string, to: string) => fs.rename(from, to));
  const remove = mapped((path: string, o?: { recursive?: boolean }) => fs.remove(path, o?.recursive ? { recursive: true } : undefined));

  return {
    readText: mapped((path) => fs.readTextFile(path)),
    readBytes: mapped((path) => fs.readFile(path)),

    async writeTextAtomic(path, text) {
      const tmp = `${dirname(path)}/.${basename(path)}.${crypto.randomUUID()}.tmp`;
      // The plugin has no chmod; the mode applies on create, so an existing file's mode carries over (less the umask).
      const mode = await lstat(path).then((s) => s.mode & 0o7777, () => undefined);
      try {
        await mapped(fs.writeTextFile)(tmp, text, mode === undefined ? undefined : { mode });
        await rename(tmp, path);
      } catch (e) {
        await remove(tmp).catch(() => {});
        throw e;
      }
    },

    writeBytes: mapped((path, data, o) => fs.writeFile(path, data, o?.mode === undefined ? undefined : { mode: o.mode })),
    // Like lstat: a dangling symlink exists.
    exists: (path) => lstat(path).then(() => true, () => false),
    stat: mapped(async (path) => describe(await fs.stat(path))),
    lstat,
    realPath: mapped((path) => invoke<string>("real_path", { path })),
    readDir: mapped(async (path) => (await fs.readDir(path)).map((e) => ({ name: e.name, kind: kindOf(e) }))),
    mkdirp: mapped((path) => fs.mkdir(path, { recursive: true })),
    rename,
    copyFile: mapped((from, to) => fs.copyFile(from, to)),
    remove,

    async makeTempDir(prefix) {
      const dir = `${appData}/tmp/${prefix}${crypto.randomUUID().slice(0, 8)}`;
      await mapped(fs.mkdir)(dir, { recursive: true });
      return dir;
    },
  };
}
