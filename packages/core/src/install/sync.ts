// Sync: refresh everything Loadout installed (SYNC-01..06). One pass per name over the winning entries
// that have a managed install, each with its dependency closure in its own catalog. An item whose
// source and copy are both provably unchanged is skipped (UPD-04/05); unmanaged content is reported and
// never overwritten (A2, the fix for SYNC-03); failures are per item and the run goes on (SYNC-04).
// An off skill refreshes in place and stays off (SYNC-01 rebuild).
import { resolveDeps } from "../deps/deps.ts";
import type { CallOpts } from "../git/git.ts";
import { createOperation } from "../git/operation.ts";
import { loadoutCtx, planLoadoutSync, type LoadoutSyncPlan } from "../loadouts/loadouts.ts";
import { ok, type Entry, type Result, type Warning } from "../model/model.ts";
import type { ReceiptV2 } from "../receipts/receipts.ts";
import { loadRegistry } from "../registry/registry.ts";
import { destFor, destState, readLegacyInstalls, type Origin } from "../scan/scan.ts";
import { checkUpdate } from "../update/update.ts";
import { checkItems, installItem } from "./apply.ts";
import { buildItem, catalogKeys, discardPlan, planFingerprint, type InstallCtx, type PlanItem, type Preview } from "./plan.ts";

type Ref = Pick<Entry, "type" | "name" | "catalog">;

export interface SyncPlan {
  /** what will be fetched and installed, dependencies first; failed and unreachable items included */
  items: PlanItem[];
  /** UPD-08: skipped because the source and the copy are both unchanged ("unmoved": the receipt's commit advanced) */
  upToDate: (Ref & { status: "up-to-date" | "unmoved" })[];
  /** A2: a copy Loadout didn't install sits where an item would go; it is left alone */
  unmanaged: (Ref & { dest: string; origin: Origin })[];
  /** the catalog synced, when the request named one; apply reports missing receipts from it only */
  catalog?: string;
  /** per loadout with anything to check, by name */
  loadouts: LoadoutSyncPlan[];
  opDir: string;
  fingerprint: string;
}

export interface SyncReport {
  synced: (Ref & { dest: string; preview: Preview })[];
  upToDate: SyncPlan["upToDate"];
  /** SYNC-04: per item, the run went on */
  failed: (Ref & { reason: string })[];
  /** SYNC-02: dependencies that were not installed before this run */
  dependencies: (Ref & { requiredBy: string[] })[];
  unmanaged: SyncPlan["unmanaged"];
  /** SYNC-06: receipts whose destination is gone; reported, never reinstalled */
  missing: ReceiptV2[];
  loadouts: { name: string; synced: (Ref & { dest: string; preview: Preview })[]; upToDate: LoadoutSyncPlan["upToDate"]; failed: (Ref & { reason: string })[] }[];
}

export async function planSync(ctx: InstallCtx, req: { catalog?: string; force?: boolean } = {}, opts: CallOpts = {}): Promise<Result<SyncPlan>> {
  const { host } = ctx;
  const home = host.paths.home;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(host, loaded.value.config);
  const receipts = await ctx.receipts.all();
  if (!receipts.ok) return receipts;
  const warnings: Warning[] = [...receipts.warnings];
  const byDest = new Map(receipts.value.map((r) => [r.dest, r]));
  const legacy = await readLegacyInstalls(host, loaded.value.config.imported?.installs);
  const keys = await catalogKeys(host, registry);

  // SYNC-01: the winning copy of each name, when Loadout installed it and it is still there (SYNC-06: a gone one isn't reinstalled).
  const targets: Entry[] = [];
  for (const e of registry.winners().values()) {
    const dest = destFor(home, e.type, e.name);
    if ((req.catalog === undefined || e.catalog === req.catalog) && byDest.has(dest) && (await host.fs.exists(dest))) targets.push(e);
  }

  const op = await createOperation(host, ctx.git);
  const plan: SyncPlan = { items: [], upToDate: [], unmanaged: [], ...(req.catalog !== undefined && { catalog: req.catalog }), loadouts: [], opDir: op.dir, fingerprint: "" };
  const seen = new Set<string>();
  for (const target of targets) {
    const deps = resolveDeps(registry.entriesOf(target.catalog), target);
    warnings.push(...deps.warnings);
    for (const entry of deps.order) {
      const key = `${entry.type}:${entry.name}`;
      const isDependency = entry !== target;
      if (seen.has(key)) {
        const planned = plan.items.find((i) => `${i.type}:${i.name}` === key);
        if (planned && isDependency && planned.requiredBy.length > 0) planned.requiredBy.push(target.name);
        continue;
      }
      seen.add(key);
      const ref = { type: entry.type, name: entry.name, catalog: entry.catalog };
      const dest = destFor(home, entry.type, entry.name);
      const receipt = byDest.get(dest) ?? null;
      const state = await destState(host, dest, receipt, legacy);
      if (state.state === "unmanaged") {
        plan.unmanaged.push({ ...ref, dest, origin: state.origin });
        continue;
      }
      const check = await checkUpdate({ host, op, receipts: ctx.receipts }, entry, receipt, { force: req.force ?? false });
      if (check.status !== "changed") {
        plan.upToDate.push({ ...ref, status: check.status });
        continue;
      }
      // SYNC-02: a dependency is reported as a dependency write only when it wasn't installed before.
      const requiredBy = isDependency && state.state === "absent" ? [target.name] : [];
      plan.items.push(await buildItem(ctx, op, entry, state, { catalogKey: keys.get(entry.catalog)!, requiredBy, provenance: registry.overrideSplit(entry), opts }));
    }
  }

  const loadouts = Object.entries(loaded.value.config.loadouts ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, loadout] of loadouts) {
    const planned = await planLoadoutSync(ctx, op, registry, name, loadout, req, opts);
    if (!planned.ok) return planned;
    warnings.push(...planned.warnings);
    const hasWork = planned.value.items.length + planned.value.upToDate.length > 0;
    if (hasWork) plan.loadouts.push(planned.value);
  }
  plan.fingerprint = await planFingerprint(host, [...plan.items, ...plan.loadouts.flatMap((l) => l.items)]);
  return ok(plan, warnings);
}

export async function applySync(ctx: InstallCtx, plan: SyncPlan, opts: { signal?: AbortSignal } = {}): Promise<Result<SyncReport>> {
  // Sync never replaces unmanaged content in the install dirs, so nothing there is consented to.
  const checked = await checkItems(ctx, plan.items, new Set());
  if (!checked.ok) return checked;
  // A loadout's folder is Loadout's alone, so what it holds without a receipt is replaced.
  for (const l of plan.loadouts) {
    const unreceipted = new Set(l.items.filter((i) => i.needsConsent).map((i) => i.dest));
    const checkedLoadout = await checkItems(loadoutCtx(ctx, l.name), l.items, unreceipted);
    if (!checkedLoadout.ok) return checkedLoadout;
  }

  const report: SyncReport = { synced: [], upToDate: plan.upToDate, failed: [], dependencies: [], unmanaged: plan.unmanaged, missing: [], loadouts: [] };
  try {
    for (const item of plan.items) {
      const ref = { type: item.type, name: item.name, catalog: item.catalog };
      if (opts.signal?.aborted) {
        report.failed.push({ ...ref, reason: "cancelled" });
        continue;
      }
      const failed = item.status === "ready" ? await installItem(ctx, item) : (item.reason ?? item.status);
      if (failed !== null) {
        report.failed.push({ ...ref, reason: failed });
        continue;
      }
      report.synced.push({ ...ref, dest: item.dest, preview: item.preview });
      if (item.requiredBy.length > 0) report.dependencies.push({ ...ref, requiredBy: item.requiredBy });
    }
    for (const l of plan.loadouts) {
      const into = loadoutCtx(ctx, l.name);
      const done: SyncReport["loadouts"][number] = { name: l.name, synced: [], upToDate: l.upToDate, failed: [] };
      for (const item of l.items) {
        const ref = { type: item.type, name: item.name, catalog: item.catalog };
        if (opts.signal?.aborted) {
          done.failed.push({ ...ref, reason: "cancelled" });
          continue;
        }
        const failed = item.status === "ready" ? await installItem(into, item) : (item.reason ?? item.status);
        if (failed === null) done.synced.push({ ...ref, dest: item.dest, preview: item.preview });
        else done.failed.push({ ...ref, reason: failed });
      }
      report.loadouts.push(done);
    }
  } finally {
    await discardPlan(ctx.host, plan);
  }

  // SYNC-04, SYNC-06: computed after the run, filtered to the catalog synced.
  const receipts = await ctx.receipts.all();
  if (receipts.ok) {
    for (const r of receipts.value) {
      if ((plan.catalog === undefined || r.catalog.id === plan.catalog) && !(await ctx.host.fs.exists(r.dest))) report.missing.push(r);
    }
  }
  return ok(report, receipts.warnings);
}
