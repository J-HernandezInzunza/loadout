// Applying an install plan (architecture.md §5.2, R14). Every check runs before any effect: the
// destinations still look as planned (STALE_PLAN), the staged copies are still there, and every
// unmanaged destination was consented to by its exact path (Q8 A). Then each item moves into place:
// old copy aside, staged copy renamed in, old copy removed, receipt written. A failure stops the run
// with earlier items kept (INST-07); a failed rename puts the old copy back.
import type { Host } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";
import type { ReceiptV2 } from "../receipts/receipts.ts";
import { destState, readLegacyInstalls } from "../scan/scan.ts";
import { destFingerprint, discardPlan, type InstallCtx, type InstallPlan, type PlanItem } from "./plan.ts";

export interface ApplyOpts {
  /** exact destination paths of unmanaged content the user agreed to replace */
  overwrite?: { unmanaged?: string[] };
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; item: Pick<PlanItem, "type" | "name" | "dest"> }) => void;
}

export interface ApplyReport {
  installed: Pick<PlanItem, "type" | "name" | "dest" | "preview">[];
  /** INST-07: the item the run stopped at, with why; later items were not touched */
  stopped: { name: string; reason: string } | null;
  aborted: boolean;
}

const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));
// INST-04: UTC to the second, as the CLI writes it.
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function copyTree(host: Host, from: string, to: string): Promise<void> {
  if ((await host.fs.stat(from)).kind === "file") return host.fs.copyFile(from, to);
  await host.fs.mkdirp(to);
  for (const e of await host.fs.readDir(from)) await copyTree(host, `${from}/${e.name}`, `${to}/${e.name}`);
}

/** Renames `from` to `to`; across volumes, copies next to `to` first so the final step is still a rename. */
async function moveInto(host: Host, from: string, to: string): Promise<void> {
  try {
    await host.fs.rename(from, to);
  } catch (e) {
    if ((e as { code?: string }).code !== "EXDEV") throw e;
    const near = `${dirname(to)}/.loadout-incoming-${to.slice(to.lastIndexOf("/") + 1)}`;
    await host.fs.remove(near, { recursive: true }).catch(() => {});
    await copyTree(host, from, near);
    await host.fs.rename(near, to);
  }
  host.audit({ kind: "fs", op: "move", path: from, to });
}

/** Replaces `dest` with `staged`: the old copy moves aside and comes back if the move in fails. */
export async function placeOne(host: Host, staged: string, dest: string): Promise<void> {
  // Beside the destination, so moving the old copy aside never crosses volumes; dot-named, so scans skip it.
  const backup = `${dirname(dest)}/.loadout-previous-${dest.slice(dest.lastIndexOf("/") + 1)}`;
  await host.fs.mkdirp(dirname(dest));
  await host.fs.remove(backup, { recursive: true }).catch(() => {});
  const hadOld = await host.fs.exists(dest);
  if (hadOld) {
    await host.fs.rename(dest, backup);
    host.audit({ kind: "fs", op: "move", path: dest, to: backup });
  }
  try {
    await moveInto(host, staged, dest);
  } catch (e) {
    if (hadOld) {
      await host.fs.rename(backup, dest);
      host.audit({ kind: "fs", op: "move", path: backup, to: dest });
    }
    throw e;
  }
  if (hadOld) {
    await host.fs.remove(backup, { recursive: true });
    host.audit({ kind: "fs", op: "delete", path: backup });
  }
}

/** Every check before the first effect: destinations as planned, staged copies present, unmanaged content consented to. */
export async function checkItems(ctx: InstallCtx, items: PlanItem[], consented: Set<string>): Promise<Result<void>> {
  const { host } = ctx;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const legacy = await readLegacyInstalls(host, loaded.value.config.imported?.installs);
  const receipts = await ctx.receipts.all();
  if (!receipts.ok) return receipts;
  const byDest = new Map(receipts.value.map((r) => [r.dest, r]));
  for (const item of items) {
    const now = await destState(host, item.dest, byDest.get(item.dest) ?? null, legacy);
    if ((await destFingerprint(host, item.dest, now)) !== item.destFingerprint) {
      return err({ code: "STALE_PLAN", message: `${item.dest} changed since this was planned; plan it again` });
    }
    if (item.fetched && !(await host.fs.exists(item.fetched.staged))) {
      return err({ code: "STALE_PLAN", message: "the planned copies are gone (the plan was discarded); plan it again" });
    }
    if (item.needsConsent && item.status === "ready" && !consented.has(item.dest)) {
      return err({ code: "REFUSED", message: `${item.dest} holds content Loadout didn't install; name it in overwrite.unmanaged to replace it` });
    }
  }
  return ok(undefined);
}

/** Moves one ready item into place and writes its receipt; null on success, else why it failed. */
export async function installItem(ctx: InstallCtx, item: PlanItem): Promise<string | null> {
  const { host } = ctx;
  try {
    await placeOne(host, item.fetched!.staged, item.dest);
  } catch (e) {
    return (e as Error).message;
  }
  const receipt: ReceiptV2 = {
    dest: item.dest,
    type: item.type,
    name: item.name,
    catalog: { id: item.catalog, key: item.catalogKey },
    source: item.source,
    commit: item.fetched!.commit,
    sourceOid: item.fetched!.sourceOid,
    files: item.fetched!.files,
    installedAt: utc(host.now()),
  };
  const saved = await ctx.receipts.put(receipt);
  return saved.ok ? null : saved.error.message;
}

export async function applyInstall(ctx: InstallCtx, plan: InstallPlan, opts: ApplyOpts = {}): Promise<Result<ApplyReport>> {
  const checked = await checkItems(ctx, plan.items, new Set(opts.overwrite?.unmanaged ?? []));
  if (!checked.ok) return checked;

  const report: ApplyReport = { installed: [], stopped: null, aborted: false };
  try {
    for (const [i, item] of plan.items.entries()) {
      if (opts.signal?.aborted) {
        report.aborted = true;
        break;
      }
      const failed = item.status === "ready" ? await installItem(ctx, item) : (item.reason ?? item.status);
      if (failed !== null) {
        report.stopped = { name: item.name, reason: failed };
        break;
      }
      report.installed.push({ type: item.type, name: item.name, dest: item.dest, preview: item.preview });
      opts.onProgress?.({ done: i + 1, total: plan.items.length, item: { type: item.type, name: item.name, dest: item.dest } });
    }
  } finally {
    await discardPlan(ctx.host, plan);
  }
  return ok(report);
}
