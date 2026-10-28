// Planning an install (architecture.md §5.2, Q5 A, Q8 A): resolve every name first (RES-05), merge
// the dependency closures (DEP-06), fetch each item into one operation, and preview per destination
// which files would be added, removed or modified, and which of those the user edited. Nothing in an
// install dir changes here; apply (M2.14) re-checks the fingerprint and renames the staged copies in.
import type { ConfigStore } from "../config/config.ts";
import { mergeOrders, resolveDeps } from "../deps/deps.ts";
import { fetchEntry, type Fetched } from "../fetch/fetch.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import { createOperation } from "../git/operation.ts";
import type { Host } from "../host.ts";
import { ok, type Entry, type Result, type Warning } from "../model/model.ts";
import { fileManifest } from "../receipts/hash.ts";
import type { ReceiptStore } from "../receipts/receipts.ts";
import { loadRegistry, type Provenance, type ResolveErr } from "../registry/registry.ts";
import { destFor, destState, readLegacyInstalls, type DestState, type Origin } from "../scan/scan.ts";

export interface InstallCtx {
  host: Host;
  git: GitClient;
  config: ConfigStore;
  receipts: ReceiptStore;
}

export type Preview =
  /** INST-03, with what the user edited among the files the install would change */
  | { kind: "files"; newInstall: boolean; added: string[]; removed: string[]; modified: string[]; editedLocally: string[] }
  /** Q5 A: the source couldn't be fetched, so only the destination is known */
  | { kind: "destination-only" };

export interface PlanItem {
  type: Entry["type"];
  name: string;
  catalog: string;
  dest: string;
  /** the names asked for that brought this item in; empty for a requested item itself */
  requiredBy: string[];
  /** A27: override provenance of this item, not just the first one asked for */
  provenance: Provenance;
  state: DestState["state"];
  origin?: Origin;
  /** Q8 A: the destination holds content Loadout didn't install; apply replaces it only with consent */
  needsConsent: boolean;
  status: "ready" | "unreachable" | "failed";
  /** why an item is unreachable or failed */
  reason?: string;
  preview: Preview;
  /** what apply moves into place; absent unless ready */
  fetched?: Fetched;
  /** the destination as planned (state and files), re-checked by apply */
  destFingerprint: string;
}

export interface InstallPlan {
  /** dependencies first */
  items: PlanItem[];
  /** the operation dir holding every staged copy; discardPlan removes it */
  opDir: string;
  fingerprint: string;
}

const sortedDiff = (xs: string[]) => [...xs].sort();

async function sha(host: Host, value: unknown): Promise<string> {
  return host.sha256(new TextEncoder().encode(JSON.stringify(value)));
}

/** What a destination looks like right now, as apply will see it. */
export async function destFingerprint(host: Host, dest: string, state: DestState): Promise<string> {
  return sha(host, { state: state.state, files: state.state === "absent" ? null : await fileManifest(host, dest) });
}

async function preview(host: Host, dest: string, state: DestState, fetched: Fetched): Promise<Preview> {
  if (state.state === "absent") return { kind: "files", newInstall: true, added: [], removed: [], modified: [], editedLocally: [] };
  const onDisk = await fileManifest(host, dest);
  const incoming = fetched.files;
  const added = sortedDiff(Object.keys(incoming).filter((f) => !(f in onDisk)));
  const removed = sortedDiff(Object.keys(onDisk).filter((f) => !(f in incoming)));
  const modified = sortedDiff(Object.keys(incoming).filter((f) => f in onDisk && onDisk[f] !== incoming[f]));
  // Edits are only knowable against a receipt: a drifted copy's modified and added files that the install would overwrite or delete.
  const edited = state.state === "drifted" ? new Set([...state.edits.modified, ...state.edits.added]) : new Set<string>();
  const editedLocally = sortedDiff([...modified, ...removed].filter((f) => edited.has(f)));
  return { kind: "files", newInstall: false, added, removed, modified, editedLocally };
}

export async function planInstall(
  ctx: InstallCtx,
  req: { names: string[]; catalog?: string },
  opts: CallOpts = {},
): Promise<Result<InstallPlan, ResolveErr>> {
  const { host } = ctx;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(host, loaded.value.config);

  // RES-05: every name resolves before anything is fetched.
  const targets = registry.resolveAll(req.names, req.catalog);
  if (!targets.ok) return targets;

  const warnings: Warning[] = [...targets.warnings];
  const requiredBy = new Map<Entry, Set<string>>();
  const orders = targets.value.map((target) => {
    const deps = resolveDeps(registry.entriesOf(target.catalog), target);
    warnings.push(...deps.warnings);
    for (const e of deps.order) if (e !== target) (requiredBy.get(e) ?? requiredBy.set(e, new Set()).get(e)!).add(target.name);
    return deps.order;
  });
  // DEP-06: one copy of each (type, name), dependencies first, in request order.
  const items = mergeOrders(orders);
  const requested = new Set(targets.value);

  const receipts = await ctx.receipts.all();
  if (!receipts.ok) return receipts;
  warnings.push(...receipts.warnings);
  const byDest = new Map(receipts.value.map((r) => [r.dest, r]));
  const legacy = await readLegacyInstalls(host, loaded.value.config.imported?.installs);

  const op = await createOperation(host, ctx.git);
  const planned: PlanItem[] = [];
  for (const entry of items) {
    const dest = destFor(host.paths.home, entry.type, entry.name);
    const state = await destState(host, dest, byDest.get(dest) ?? null, legacy);
    const fetched = await fetchEntry(host, ctx.git, op, entry, opts);
    const status: PlanItem["status"] = fetched.ok ? "ready" : fetched.error.code === "GIT_FAILED" ? "unreachable" : "failed";
    planned.push({
      type: entry.type,
      name: entry.name,
      catalog: entry.catalog,
      dest,
      requiredBy: requested.has(entry) ? [] : [...(requiredBy.get(entry) ?? [])],
      provenance: registry.overrideSplit(entry),
      state: state.state,
      ...(state.state === "unmanaged" && { origin: state.origin }),
      needsConsent: state.state === "unmanaged",
      status,
      ...(!fetched.ok && { reason: fetched.error.message }),
      preview: fetched.ok ? await preview(host, dest, state, fetched.value) : { kind: "destination-only" },
      ...(fetched.ok && { fetched: fetched.value }),
      destFingerprint: await destFingerprint(host, dest, state),
    });
  }

  const fingerprint = await sha(host, planned.map((p) => [p.dest, p.destFingerprint, p.fetched?.commit ?? null, p.fetched?.files ?? null]));
  return ok({ items: planned, opDir: op.dir, fingerprint }, warnings);
}

/** Removes a plan's staged copies when it won't be applied. */
export async function discardPlan(host: Host, plan: InstallPlan): Promise<void> {
  if (!(await host.fs.exists(plan.opDir))) return;
  await host.fs.remove(plan.opDir, { recursive: true });
  host.audit({ kind: "fs", op: "delete", path: plan.opDir });
}
