// Fetching an entry's content into its operation's staging area (FETCH-05..12). Nothing here touches
// an install dir: apply renames the staged copy into place (R14), so an interrupted install never
// leaves half a skill behind.
import type { Host } from "../host.ts";
import { LibraryError, err, ok, type Entry, type Result } from "../model/model.ts";
import type { Operation } from "../git/operation.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import { fileManifest } from "../receipts/hash.ts";
import { destFor } from "../scan/scan.ts";
import { parseSource } from "../source/source.ts";

export interface Fetched {
  /** the staged copy: a folder for a skill, `<name>.md` otherwise */
  staged: string;
  /** source repo HEAD; null for a local source (FETCH-07) */
  commit: string | null;
  /** oid of what was copied: the skill's folder or the file (FETCH-05) */
  sourceOid: string | null;
  files: Record<string, string>;
}

const dirname = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

/** Python's `Path.resolve()`: symlinks resolved as far as the path exists, the rest appended. */
async function resolveLoose(host: Host, path: string): Promise<string> {
  const rest: string[] = [];
  let at = path;
  while (at !== "/") {
    try {
      return [await host.fs.realPath(at), ...rest].join("/");
    } catch {
      rest.unshift(at.slice(at.lastIndexOf("/") + 1));
      at = dirname(at);
    }
  }
  return "/" + rest.join("/");
}

/** FETCH-08: a copy whose source and destination overlap would delete the only copy. */
async function refuseOverlap(host: Host, origin: string, dest: string): Promise<Result<void>> {
  const [o, d] = await Promise.all([resolveLoose(host, origin), resolveLoose(host, dest)]);
  if (o !== d && !o.startsWith(d + "/") && !d.startsWith(o + "/")) return ok(undefined);
  return err({
    code: "REFUSED",
    message:
      `refusing to install ${d} from ${o}: the source is the destination. Installing would delete the only copy; ` +
      "move the content out of the install directory and point the entry's source at its new home.",
  });
}

/** Copies `from` into `to`, following symlinks (shutil.copytree's default) and skipping dangling ones and a top-level `.git` (FETCH-10). */
export async function copyTree(host: Host, from: string, to: string, top = true): Promise<void> {
  await host.fs.mkdirp(to);
  for (const e of await host.fs.readDir(from)) {
    if (top && e.name === ".git") continue;
    const src = `${from}/${e.name}`;
    const kind = e.kind === "symlink" ? await host.fs.stat(src).then((s) => s.kind, () => null) : e.kind;
    if (kind === "dir") await copyTree(host, src, `${to}/${e.name}`, false);
    else if (kind === "file") await host.fs.copyFile(src, `${to}/${e.name}`);
  }
}

export async function fetchEntry(host: Host, git: GitClient, op: Operation, entry: Entry, opts: CallOpts = {}): Promise<Result<Fetched>> {
  let src;
  try {
    src = parseSource(entry.source, host.paths.home);
  } catch (e) {
    if (e instanceof LibraryError) return err({ code: e.code, message: e.message });
    throw e;
  }

  let ref: string;
  let commit: string | null = null;
  let sourceOid: string | null = null;
  if (src.kind === "local") {
    ref = src.path;
    if (!(await host.fs.exists(ref))) return err({ code: "SOURCE_MISSING", message: `local source not found: ${ref}` });
  } else {
    const checkout = await op.clones.checkout(src, opts);
    if (!checkout.ok) return checkout;
    ref = src.filePath === "" ? checkout.value : `${checkout.value}/${src.filePath}`;
    if (!(await host.fs.exists(ref))) return err({ code: "SOURCE_MISSING", message: `referenced file missing in repo: ${src.filePath}` });
    commit = await git.revParse(checkout.value, "HEAD");
    sourceOid = await git.revParse(checkout.value, `HEAD:${entry.type === "skill" ? src.parentPath : src.filePath}`);
  }

  // FETCH-06, FETCH-11: a skill installs the folder holding its source, even when the source is itself a folder.
  const origin = entry.type === "skill" ? dirname(ref) : ref;
  if (src.kind === "local") {
    const refused = await refuseOverlap(host, origin, destFor(host.paths.home, entry.type, entry.name));
    if (!refused.ok) return refused;
  }

  // Staging lives with the operation, so dispose() takes it too.
  const stage = op.path("stage");
  await host.fs.mkdirp(stage);
  const staged = entry.type === "skill" ? `${stage}/${entry.name}` : `${stage}/${entry.name}.md`;
  if (entry.type === "skill") {
    await copyTree(host, origin, staged);
    // FETCH-12 (rebuild): a real check, where the CLI's always passed.
    if (!(await host.fs.exists(`${staged}/SKILL.md`))) {
      return err({ code: "VERIFY_FAILED", message: `${entry.name}: no SKILL.md in ${origin}` });
    }
  } else {
    if ((await host.fs.stat(origin)).kind !== "file") {
      return err({ code: "VERIFY_FAILED", message: `${entry.name}: ${origin} is not a file` });
    }
    await host.fs.copyFile(origin, staged);
  }
  return ok({ staged, commit, sourceOid, files: await fileManifest(host, staged) });
}
