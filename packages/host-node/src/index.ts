// Host implemented with node:fs/promises and node:child_process (architecture.md §2.1): the core's
// test host, and the future agent host.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AuditEvent, FileKind, Host, ProcResult } from "@loadout/core";

export interface NodeHostOptions {
  home: string;
  appData: string;
  onAudit?: (event: AuditEvent) => void;
  now?: () => Date;
}

function kindOf(s: Stats): FileKind {
  if (s.isSymbolicLink()) return "symlink";
  return s.isDirectory() ? "dir" : "file";
}

function describe(s: Stats) {
  return { kind: kindOf(s), size: s.size, mode: s.mode };
}

export function createNodeHost(opts: NodeHostOptions): Host {
  const audit = opts.onAudit ?? (() => {});
  let nextProcId = 1;

  return {
    paths: { home: opts.home, appData: opts.appData },
    now: opts.now ?? (() => new Date()),
    audit,

    async sha256(data) {
      return createHash("sha256").update(data).digest("hex");
    },

    fs: {
      readText: (path) => readFile(path, "utf8"),
      readBytes: async (path) => new Uint8Array(await readFile(path)),

      async writeTextAtomic(path, text) {
        const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
        const mode = await stat(path).then((s) => s.mode & 0o7777, () => undefined);
        try {
          await writeFile(tmp, text, { flush: true });
          if (mode !== undefined) await chmod(tmp, mode);
          await rename(tmp, path);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
      },

      async writeBytes(path, data, o) {
        await writeFile(path, data);
        if (o?.mode !== undefined) await chmod(path, o.mode);
      },

      exists: (path) => lstat(path).then(() => true, () => false),
      stat: async (path) => describe(await stat(path)),
      lstat: async (path) => describe(await lstat(path)),
      realPath: (path) => realpath(path),

      async readDir(path) {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file",
        }));
      },

      mkdirp: async (path) => {
        await mkdir(path, { recursive: true });
      },
      rename: (from, to) => rename(from, to),
      copyFile: (from, to) => copyFile(from, to),

      async remove(path, o) {
        if (o?.recursive) await rm(path, { recursive: true });
        else if ((await lstat(path)).isDirectory()) await rm(path, { recursive: false });
        else await unlink(path);
      },

      async makeTempDir(prefix) {
        const base = join(opts.appData, "tmp");
        await mkdir(base, { recursive: true });
        return mkdtemp(join(base, prefix));
      },
    },

    proc: {
      run(program, args, o) {
        const id = nextProcId++;
        const started = performance.now();
        audit({ kind: "proc:start", id, argv: [program, ...args], ...(o.cwd !== undefined && { cwd: o.cwd }) });

        return new Promise<ProcResult>((resolve, reject) => {
          if (o.signal?.aborted) {
            audit({ kind: "proc:end", id, code: -1, durationMs: 0 });
            return reject(abortError());
          }
          const child = spawn(program, args, {
            cwd: o.cwd,
            env: { ...process.env, ...o.env },
            // No stdin: git and gh must fail rather than wait on a prompt.
            stdio: ["ignore", "pipe", "pipe"],
            // Own process group, so a timeout or abort also kills what git spawned (ssh, remote
            // helpers); otherwise they hold stdout open and the run never ends.
            detached: true,
          });
          let stdout = "";
          let stderr = "";
          let aborted = false;
          child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
          child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));

          const killGroup = () => {
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            } catch {
              // already gone
            }
          };
          const timer = o.timeoutMs !== undefined ? setTimeout(killGroup, o.timeoutMs) : undefined;
          const onAbort = () => {
            aborted = true;
            killGroup();
          };
          o.signal?.addEventListener("abort", onAbort, { once: true });

          const end = (code: number) => {
            clearTimeout(timer);
            o.signal?.removeEventListener("abort", onAbort);
            const durationMs = Math.round(performance.now() - started);
            audit({ kind: "proc:end", id, code, durationMs });
            return durationMs;
          };
          // Spawn failures (ENOENT: program not installed) reject rather than resolve a code.
          child.on("error", (err) => {
            end(-1);
            reject(err);
          });
          child.on("close", (code, signal) => {
            const exit = code ?? (signal === "SIGKILL" ? 137 : -1);
            const durationMs = end(exit);
            if (aborted) reject(abortError());
            else resolve({ code: exit, stdout, stderr, durationMs });
          });
        });
      },
    },
  };
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
