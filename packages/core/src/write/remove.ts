// Removing an entry from its catalog (behaviors.md §3.14). Entries of the same catalog that require it
// are named before the write (DEP-09); the block goes through removeEntry (EDIT-10) and the catalog's
// write mode. With purge, the entry's installed copy goes too, after the write and never on a dry run.
import type { ClaudeSettings } from "../claudeSettings/settings.ts";
import type { CallOpts } from "../git/git.ts";
import { uninstall } from "../install/uninstall.ts";
import { ok, type EntryType, type Result, type Warning } from "../model/model.ts";
import type { ReceiptStore } from "../receipts/receipts.ts";
import { loadRegistry } from "../registry/registry.ts";
import { destFor } from "../scan/scan.ts";
import type { WriteResult } from "./edit.ts";
import { writeTarget, type WriteTargetErr } from "./target.ts";
import { applyWrite, planWrite, type ModePlan, type WriteCtx } from "./write.ts";

export interface RemoveRequest {
  name: string;
  catalog?: string;
  type?: EntryType;
  /** also uninstall the entry's installed copy */
  purge?: boolean;
  dryRun?: boolean;
}

export interface RemovePlan {
  write: ModePlan;
  removed: { type: EntryType; name: string };
  /** DEP-09: `type:name` of the entries in the same catalog that require it */
  dependents: string[];
  purge: boolean;
}

export async function planRemove(ctx: WriteCtx, req: RemoveRequest, opts: CallOpts = {}): Promise<Result<RemovePlan, WriteTargetErr>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const target = writeTarget(registry, { op: "remove", name: req.name, ...(req.type && { type: req.type }), ...(req.catalog !== undefined && { catalog: req.catalog }) });
  if (!target.ok) return target;
  const { catalog: dest, entry } = target.value;
  const removed = { type: entry!.type, name: entry!.name };

  // DEP-09: the exact ref string, direct dependents only.
  const ref = `${removed.type}:${removed.name}`;
  const dependents = dest.entries.filter((e) => e.requires.includes(ref)).map((e) => `${e.type}:${e.name}`);
  const warnings: Warning[] = dependents.length > 0 ? [{ message: `removing a dependency of: ${dependents.join(", ")}` }] : [];

  const planned = await planWrite(ctx, dest, { op: "remove", ...removed }, { ...opts, ...(req.dryRun && { dryRun: true }) });
  if (!planned.ok) return planned;
  return ok({ write: planned.value, removed, dependents, purge: (req.purge ?? false) && !req.dryRun }, [...warnings, ...planned.warnings]);
}

export async function applyRemove(
  ctx: WriteCtx & { receipts: ReceiptStore; settings: ClaudeSettings },
  plan: RemovePlan,
  opts: CallOpts = {},
): Promise<Result<WriteResult & { removed: RemovePlan["removed"]; dependents: string[]; deleted: string[] }>> {
  const written = await applyWrite(ctx, plan.write, opts);
  if (!written.ok) return written;
  const extra = { removed: plan.removed, dependents: plan.dependents, deleted: [] as string[] };
  if (!plan.purge) return ok({ ...written.value, ...extra }, written.warnings);

  // The CLI's --purge is a forced uninstall: the copy goes whoever installed it.
  const { type, name } = plan.removed;
  const dest = destFor(ctx.host.paths.home, type, name);
  const purged = await uninstall(ctx, { names: [name], forcePaths: [dest], types: { [name]: type } });
  if (!purged.ok) return ok({ ...written.value, ...extra }, [...written.warnings, { message: `removed from the catalog, but not uninstalled: ${purged.error.message}` }]);
  const deleted = purged.value.items.filter((i) => i.outcome === "deleted").map((i) => i.dest);
  return ok({ ...written.value, ...extra, deleted }, [...written.warnings, ...purged.warnings]);
}
