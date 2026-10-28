// Per-operation git state (FETCH-04, FETCH-09; architecture.md §4.1): one temp dir `tmp/<op id>/`
// holding one checkout and one blobless probe per repo+branch, all removed when the operation ends.
// A killed operation leaves its dir behind; the launch sweep removes it.
import type { Host } from "../host.ts";
import type { Result } from "../model/model.ts";
import type { RemoteSource } from "../source/source.ts";
import type { CallOpts, GitClient } from "./git.ts";

type Repo = Pick<RemoteSource, "kind" | "org" | "repo" | "branch">;

/** The key UPD-01, FETCH-04 and the probes share: one repo+branch is one thing per operation. */
export const repoKey = (src: Repo) => `${src.kind}:${src.org}/${src.repo}@${src.branch}`;

export interface CloneCache {
  /** The checkout for `src`'s repo+branch, cloned once per operation; a failure is remembered too. */
  checkout(src: Repo, opts?: CallOpts): Promise<Result<string>>;
}

export interface ProbeCache {
  /** UPD-02: the tip commit and the oid of `path` there; null when unknown (no probe, or no such path). */
  oid(src: Repo, path: string, opts?: CallOpts): Promise<{ commit: string; oid: string } | null>;
}

export interface Operation {
  dir: string;
  clones: CloneCache;
  probes: ProbeCache;
  /** A fresh path inside the operation's dir (not created), e.g. for staging. */
  path(prefix: string): string;
  /** Removes the operation's dir and everything in it. */
  dispose(): Promise<void>;
}

export async function createOperation(host: Host, git: GitClient): Promise<Operation> {
  const dir = await host.fs.makeTempDir("op-");
  let next = 0;
  const path = (prefix: string) => `${dir}/${prefix}-${next++}`;
  // Promises, not values: two entries asking at once still share one clone.
  const checkouts = new Map<string, Promise<Result<string>>>();
  const probes = new Map<string, Promise<{ dir: string; commit: string } | null>>();

  const memo = <T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>) => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key)!;
  };

  return {
    dir,
    path,
    clones: {
      checkout(src, opts = {}) {
        return memo(checkouts, repoKey(src), async () => {
          const dest = path("clone");
          const cloned = await git.clone(await git.urlsFor(src), dest, { ...opts, branch: src.branch });
          return cloned.ok ? { ...cloned, value: dest } : cloned;
        });
      },
    },
    probes: {
      async oid(src, file, opts = {}) {
        const probed = await memo(probes, repoKey(src), async () => {
          const dest = path("probe");
          const res = await git.probe(await git.urlsFor(src), src.branch, dest, opts);
          return res.ok ? { dir: dest, commit: res.value } : null;
        });
        if (probed === null) return null;
        const oid = await git.revParse(probed.dir, `${probed.commit}:${file}`);
        return oid === null ? null : { commit: probed.commit, oid };
      },
    },
    async dispose() {
      await host.fs.remove(dir, { recursive: true });
      host.audit({ kind: "fs", op: "delete", path: dir });
    },
  };
}

/** At launch: remove what killed operations left in `<appData>/tmp`. */
export async function sweepTemp(host: Host): Promise<void> {
  const tmp = `${host.paths.appData}/tmp`;
  if (!(await host.fs.exists(tmp))) return;
  for (const entry of await host.fs.readDir(tmp)) {
    const path = `${tmp}/${entry.name}`;
    await host.fs.remove(path, { recursive: true });
    host.audit({ kind: "fs", op: "delete", path });
  }
}
