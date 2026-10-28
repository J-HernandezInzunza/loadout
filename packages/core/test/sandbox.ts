// A Node Host rooted in a per-test temp dir (architecture.md §6, after the Python suite's TempTool).
// Any fs path or process cwd outside the root is rejected and recorded; the test fails when it
// finishes with an unverified escape, even if the code under test swallowed the rejection.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { createNodeHost } from "@loadout/host-node";
import type { AuditEvent, Host, HostFs } from "@loadout/core";
import { onTestFinished } from "vitest";

export interface Sandbox {
  root: string;
  host: Host;
  audit: AuditEvent[];
  /** Throws if any call escaped since the last verify, then forgets those escapes. */
  verify(): void;
}

// How many leading arguments of each fs call are paths.
const pathArgs: Record<keyof HostFs, number> = {
  readText: 1,
  readBytes: 1,
  writeTextAtomic: 1,
  writeBytes: 1,
  exists: 1,
  stat: 1,
  lstat: 1,
  realPath: 1,
  readDir: 1,
  mkdirp: 1,
  rename: 2,
  copyFile: 2,
  remove: 1,
  makeTempDir: 0,
};

/** Call inside a test or `beforeEach`: the root is removed when the test finishes. */
export async function createSandbox(): Promise<Sandbox> {
  // realpath: macOS's tmpdir is under /var, a symlink to /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), "loadout-")));
  const home = join(root, "home");
  const appData = join(root, "appData");
  await mkdir(home);
  await mkdir(appData);

  const audit: AuditEvent[] = [];
  const escapes: string[] = [];
  const inner = createNodeHost({ home, appData, onAudit: (e) => audit.push(e) });

  const guard = (call: string, path: string) => {
    const p = normalize(path);
    if (isAbsolute(p) && (p === root || p.startsWith(root + sep))) return;
    escapes.push(`${call}: ${path}`);
    throw new Error(`${call}: ${path} escapes the sandbox ${root}`);
  };

  const fs = Object.fromEntries(
    (Object.keys(pathArgs) as (keyof HostFs)[]).map((op) => [
      op,
      async (...args: unknown[]) => {
        for (const path of args.slice(0, pathArgs[op])) guard(`fs.${op}`, path as string);
        return (inner.fs[op] as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as unknown as HostFs;

  const sandbox: Sandbox = {
    root,
    audit,
    host: {
      ...inner,
      fs,
      proc: {
        async run(program, args, opts) {
          const cwd = opts.cwd ?? root;
          guard("proc.run cwd", cwd);
          return inner.proc.run(program, args, { ...opts, cwd });
        },
      },
    },
    verify() {
      if (escapes.length === 0) return;
      const list = escapes.splice(0);
      throw new Error(`${list.length} ${list.length === 1 ? "call" : "calls"} escaped the sandbox:\n${list.join("\n")}`);
    },
  };

  onTestFinished(async () => {
    try {
      sandbox.verify();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return sandbox;
}
