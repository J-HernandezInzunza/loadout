// Has an installed item's source changed? (UPD-03..08). The cheap answer is one `ls-remote` per
// repo+branch; when the head moved, a blobless probe can still prove the item's own folder or file
// is unchanged ("unmoved"). Anything that can't be proven counts as changed, so the fallback is always
// to fetch again rather than to skip an update silently.
import type { Host } from "../host.ts";
import type { Entry } from "../model/model.ts";
import type { Operation } from "../git/operation.ts";
import { fileManifest } from "../receipts/hash.ts";
import type { ReceiptStore, ReceiptV2 } from "../receipts/receipts.ts";
import { destState } from "../scan/scan.ts";
import { parseSource, type RemoteSource } from "../source/source.ts";

export interface UpdateCtx {
  host: Host;
  op: Operation;
  receipts: ReceiptStore;
}

/** UPD-08: up to date = skip; unmoved = head moved, content didn't (skip, receipt advanced); changed = fetch. */
export type UpdateCheck = { status: "up-to-date" } | { status: "unmoved"; tip: string } | { status: "changed"; why: string };

const sourcePath = (src: RemoteSource, entry: Entry) => (entry.type === "skill" ? src.parentPath : src.filePath);

function parsed(host: Host, entry: Entry) {
  try {
    return parseSource(entry.source, host.paths.home);
  } catch {
    return null;
  }
}

/**
 * UPD-03: the tip commit when the item's folder or file there has the oid the receipt recorded; null
 * when that can't be proven. A receipt from another source never lends its oid, even to identical content.
 */
export async function contentUnmoved(ctx: UpdateCtx, entry: Entry, receipt: ReceiptV2): Promise<string | null> {
  const src = parsed(ctx.host, entry);
  if (src === null || src.kind === "local" || receipt.sourceOid === null || receipt.source !== entry.source) return null;
  const probed = await ctx.op.probes.oid(src, sourcePath(src, entry));
  return probed !== null && probed.oid === receipt.sourceOid ? probed.commit : null;
}

/** A local source equals what was installed: same file bytes, or the same files in the skill's folder. */
async function localUnchanged(host: Host, entry: Entry, path: string, receipt: ReceiptV2): Promise<boolean> {
  if (!(await host.fs.exists(path))) return false;
  const origin = entry.type === "skill" ? path.slice(0, path.lastIndexOf("/")) : path;
  const source = await fileManifest(host, origin);
  if (entry.type !== "skill") {
    const [only] = Object.values(source);
    const [installed] = Object.values(receipt.files);
    return only !== undefined && only === installed;
  }
  // Staging never copies a top-level .git (FETCH-10), so it can't count as a difference.
  const files = Object.entries(source).filter(([rel]) => rel !== ".git" && !rel.startsWith(".git/"));
  return files.length === Object.keys(receipt.files).length && files.every(([rel, hash]) => receipt.files[rel] === hash);
}

/**
 * UPD-04/05: whether sync can skip the item. Both ends must be provably unchanged: the copy reads
 * `installed` and the source still holds what the receipt recorded. An unmoved item's receipt advances
 * to the tip, so the next check is back on the single `ls-remote`.
 */
export async function checkUpdate(ctx: UpdateCtx, entry: Entry, receipt: ReceiptV2 | null, opts: { force?: boolean } = {}): Promise<UpdateCheck> {
  if (opts.force) return { status: "changed", why: "forced" };
  if (receipt === null) return { status: "changed", why: "no receipt" };
  // The receipt describes another source: neither its commit nor its oid says anything about this one.
  if (receipt.source !== entry.source) return { status: "changed", why: "the source was repointed" };
  const state = await destState(ctx.host, receipt.dest, receipt);
  if (state.state !== "installed") return { status: "changed", why: `the installed copy is ${state.state}` };
  const src = parsed(ctx.host, entry);
  if (src === null) return { status: "changed", why: "the source can't be parsed" };
  if (src.kind === "local") {
    return (await localUnchanged(ctx.host, entry, src.path, receipt)) ? { status: "up-to-date" } : { status: "changed", why: "the local source differs" };
  }
  const head = await ctx.op.heads.head(src);
  if (head === null) return { status: "changed", why: "the remote head is unknown" };
  if (head === receipt.commit) return { status: "up-to-date" };
  const tip = await contentUnmoved(ctx, entry, receipt);
  if (tip === null) return { status: "changed", why: "the source moved" };
  await ctx.receipts.put({ ...receipt, commit: tip });
  return { status: "unmoved", tip };
}

/**
 * UPD-06: `installed` but behind its source, for list. Only a known head that differs from the
 * receipt's commit, without unmoved content, is stale; an unknown head stays installed, a local source
 * is never stale, and receipts are never advanced here.
 */
export async function isStale(ctx: UpdateCtx, entry: Entry, receipt: ReceiptV2): Promise<boolean> {
  if (receipt.commit === null) return false;
  const src = parsed(ctx.host, entry);
  if (src === null || src.kind === "local") return false;
  if ((await destState(ctx.host, receipt.dest, receipt)).state !== "installed") return false;
  const head = await ctx.op.heads.head(src);
  if (head === null || head === receipt.commit) return false;
  return (await contentUnmoved(ctx, entry, receipt)) === null;
}
