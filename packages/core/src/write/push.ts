// Sending an installed copy's edits back to its source (behaviors.md §3.16). A local source is
// overwritten in place (a skill's folder replaced whole, so files only the source had go too); a
// remote source gets a branch and a pull request, as PR write mode does. The copy is the global one
// (no project scope, R9). Afterwards its receipt describes the pushed files, so the copy no longer
// reads as edited (A28): for a remote source the receipt keeps its commit, so sync leaves the copy
// alone until the source moves (the PR merging).
import type { CallOpts } from "../git/git.ts";
import { createOperation, type Operation } from "../git/operation.ts";
import { copyTree } from "../fetch/fetch.ts";
import type { ConfigStore } from "../config/config.ts";
import { placeOne } from "../install/apply.ts";
import { catalogKeys } from "../install/plan.ts";
import { LibraryError, err, ok, type Entry, type EntryType, type Result, type Warning } from "../model/model.ts";
import { fileManifest } from "../receipts/hash.ts";
import type { ReceiptStore, ReceiptV2 } from "../receipts/receipts.ts";
import { loadRegistry, type Registry, type ResolveErr } from "../registry/registry.ts";
import { destFor } from "../scan/scan.ts";
import { cloneUrls, parseSource, type RemoteSource } from "../source/source.ts";
import { branchName, freeBranch, pushAndOpenPr, type OpenedPr, type PrCtx } from "./pr.ts";

export type PushCtx = PrCtx & { config: ConfigStore; receipts: ReceiptStore };

export interface PushRequest {
  name: string;
  /** push to this catalog's entry instead of the winning one (RES-06) */
  catalog?: string;
}

export interface FileChanges {
  added: string[];
  removed: string[];
  modified: string[];
}

interface PlanBase {
  type: EntryType;
  name: string;
  catalog: string;
  source: string;
  /** the installed copy being sent back */
  dest: string;
  /** a warning when the copy may not have come from this entry's source; null when nothing is in doubt */
  note: string | null;
  changed: boolean;
  /** the copy as planned; apply refuses a copy edited since */
  files: Record<string, string>;
}

export type PushPlan = PlanBase &
  (
    | {
        kind: "local";
        /** the source file, or the folder holding a skill's source */
        target: string;
        /** the target as planned; apply refuses one changed since */
        targetFiles: Record<string, string>;
        /** what the target gains, loses and has rewritten */
        changes: FileChanges;
      }
    | {
        kind: "remote";
        repo: string;
        base: string;
        /** the temp clone with the copy staged, inside `op` */
        clone: string;
        /** the skill's folder or the file, relative to the clone */
        path: string;
        /** `git diff --cached` of the copy against the source branch */
        diff: string;
        op: Operation;
      }
  );

export type PushResult = Pick<PlanBase, "name" | "catalog" | "dest" | "note" | "changed"> &
  ({ kind: "local"; target: string } | { kind: "remote"; pr: OpenedPr | null });

const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));
const sorted = (xs: string[]) => [...xs].sort();

function changesBetween(from: Record<string, string>, to: Record<string, string>): FileChanges {
  return {
    added: sorted(Object.keys(from).filter((f) => !(f in to))),
    removed: sorted(Object.keys(to).filter((f) => !(f in from))),
    modified: sorted(Object.keys(from).filter((f) => f in to && to[f] !== from[f])),
  };
}

/**
 * `push_source_warning`: silent when no other catalog defines the name, or when the copy's receipt
 * names this catalog (by identity, so a renamed catalog isn't "another" one); sharper when the receipt
 * names another catalog; the ambiguity warning when there is no receipt.
 */
async function sourceNote(ctx: PushCtx, registry: Registry, entry: Entry, receipt: ReceiptV2 | null): Promise<string | null> {
  const others = registry.active().flatMap((c) => c.entries).filter((e) => e.name === entry.name && e.catalog !== entry.catalog);
  if (others.length === 0) return null;
  if (receipt !== null) {
    if (receipt.catalog.key === (await catalogKeys(ctx.host, registry)).get(entry.catalog)) return null;
    return (
      `this copy of '${entry.name}' was installed from '${receipt.catalog.id}' → ${receipt.source}, but this push targets ` +
      `'${entry.catalog}' → ${entry.source}. Push to catalog '${receipt.catalog.id}' to send it back where it came from.`
    );
  }
  const alternatives = others.map((e) => `'${e.catalog}' → ${e.source}`).join("; ");
  return (
    `'${entry.name}' is defined in more than one catalog and no install receipt records which copy is on disk. ` +
    `Pushing to '${entry.catalog}' → ${entry.source} (also defined by ${alternatives})`
  );
}

export async function planPush(ctx: PushCtx, req: PushRequest, opts: CallOpts = {}): Promise<Result<PushPlan, ResolveErr>> {
  const { host, git } = ctx;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(host, loaded.value.config);
  const resolved = registry.resolve(req.name, req.catalog);
  if (!resolved.ok) return resolved;
  const entry = resolved.value;

  const dest = destFor(host.paths.home, entry.type, entry.name);
  const kind = await host.fs.lstat(dest).then((s) => s.kind, () => null);
  if (kind === null) return err({ code: "NOT_FOUND", message: `'${entry.name}' is not installed; nothing to push` });
  // Scans never follow a link (R9), and a linked copy usually is its source already.
  if (kind === "symlink") return err({ code: "REFUSED", message: `${dest} is a symlink; Loadout doesn't push through links` });

  const receipt = await ctx.receipts.get(dest);
  if (!receipt.ok) return receipt;
  const note = await sourceNote(ctx, registry, entry, receipt.value);
  let src;
  try {
    src = parseSource(entry.source, host.paths.home);
  } catch (e) {
    if (e instanceof LibraryError) return err({ code: e.code, message: e.message });
    throw e;
  }
  const base = { type: entry.type, name: entry.name, catalog: entry.catalog, source: entry.source, dest, note, files: await fileManifest(host, dest) };
  const rootSkill = `${entry.source} sits at the root of a repository, so pushing would replace the whole repository with the skill; move the skill into its own folder`;

  if (src.kind === "local") {
    const target = entry.type === "skill" ? dirname(src.path) : src.path;
    // Q13 d: the folder holding a skill's source is a whole repository.
    if (entry.type === "skill" && (await host.fs.exists(`${target}/.git`))) return err({ code: "INVALID_SOURCE", message: rootSkill });
    const targetFiles = await fileManifest(host, target);
    const changes = changesBetween(base.files, targetFiles);
    const changed = changes.added.length + changes.removed.length + changes.modified.length > 0;
    return ok({ ...base, kind: "local", changed, target, targetFiles, changes });
  }

  if (entry.type === "skill" && src.parentPath === "") return err({ code: "INVALID_SOURCE", message: rootSkill });
  const path = entry.type === "skill" ? src.parentPath : src.filePath;
  const op = await createOperation(host, git);
  const staged = await stageInClone(ctx, op, src, dest, path, entry.type, opts);
  if (!staged.ok) {
    await op.dispose();
    return staged;
  }
  const { clone, diff } = staged.value;
  return ok({ ...base, kind: "remote", changed: diff !== "", repo: cloneUrls(src)[1]!, base: src.branch, clone, path, diff, op });
}

/** A temp clone of the source branch with the copy laid over the source's folder or file, staged. */
async function stageInClone(
  ctx: PushCtx,
  op: Operation,
  src: RemoteSource,
  dest: string,
  path: string,
  type: EntryType,
  opts: CallOpts,
): Promise<Result<{ clone: string; diff: string }>> {
  const { host, git } = ctx;
  const clone = op.path("push");
  const cloned = await git.clone(await git.urlsFor(src), clone, { ...opts, branch: src.branch });
  if (!cloned.ok) return cloned;
  const into = `${clone}/${path}`;
  if (type === "skill") {
    if (await host.fs.exists(into)) await host.fs.remove(into, { recursive: true });
    await copyTree(host, dest, into);
  } else {
    await host.fs.mkdirp(dirname(into));
    await host.fs.copyFile(dest, into);
  }
  const diff = await git.stagedDiff(clone, [path]);
  return diff.ok ? ok({ clone, diff: diff.value }) : diff;
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);

/** A plan that won't be applied: a remote push holds a temp clone. */
export async function discardPush(plan: PushPlan): Promise<void> {
  if (plan.kind === "remote") await plan.op.dispose();
}

export async function applyPush(ctx: PushCtx, plan: PushPlan, opts: CallOpts & { message?: string } = {}): Promise<Result<PushResult>> {
  const { host, git } = ctx;
  const head = { name: plan.name, catalog: plan.catalog, dest: plan.dest, note: plan.note, changed: plan.changed };
  try {
    if (!plan.changed) return ok(plan.kind === "local" ? { ...head, kind: "local", target: plan.target } : { ...head, kind: "remote", pr: null });
    if (!sameFiles(await fileManifest(host, plan.dest), plan.files)) {
      return err({ code: "STALE_PLAN", message: `${plan.dest} changed since the push was planned; plan it again` });
    }

    let result: PushResult;
    const warnings: Warning[] = [];
    if (plan.kind === "local") {
      if (!sameFiles(await fileManifest(host, plan.target), plan.targetFiles)) {
        return err({ code: "STALE_PLAN", message: `${plan.target} changed since the push was planned; plan it again` });
      }
      const op = await createOperation(host, git);
      try {
        const staged = `${op.path("stage")}/${plan.target.slice(plan.target.lastIndexOf("/") + 1)}`;
        if (plan.type === "skill") await copyTree(host, plan.dest, staged);
        else {
          await host.fs.mkdirp(dirname(staged));
          await host.fs.copyFile(plan.dest, staged);
        }
        await placeOne(host, staged, plan.target);
      } finally {
        await op.dispose();
      }
      result = { ...head, kind: "local", target: plan.target };
    } else {
      if (!(await host.fs.exists(plan.clone))) return err({ code: "STALE_PLAN", message: "the planned clone is gone (the plan was discarded); plan it again" });
      const message = opts.message?.trim() || `library: updated ${plan.name}`;
      const branch = await freeBranch(git, plan.clone, branchName("update", plan.name, host.now()));
      const checkedOut = await git.checkoutBranch(plan.clone, branch);
      if (!checkedOut.ok) return checkedOut;
      const committed = await git.commit(plan.clone, [plan.path], message);
      if (!committed.ok) return committed;
      const body = `Updated ${plan.type} \`${plan.name}\` via Loadout.`;
      const opened = await pushAndOpenPr(ctx, plan.clone, { repo: plan.repo, base: plan.base, branch, title: message, body }, opts);
      if (!opened.ok) return opened;
      warnings.push(...opened.warnings);
      result = { ...head, kind: "remote", pr: opened.value };
    }

    // A28: the receipt now describes what was sent, if it describes this source at all.
    const receipt = await ctx.receipts.get(plan.dest);
    if (receipt.ok && receipt.value !== null && receipt.value.source === plan.source) {
      const saved = await ctx.receipts.put({ ...receipt.value, files: plan.files });
      if (!saved.ok) warnings.push({ message: `pushed, but the install record wasn't updated (${saved.error.message}); the copy still reads as edited` });
    }
    return ok(result, warnings);
  } finally {
    await discardPush(plan);
  }
}
