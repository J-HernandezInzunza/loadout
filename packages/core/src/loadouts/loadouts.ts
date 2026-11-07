// Loadouts: named sets of catalog entries a user brings into one Claude Code session. Each is saved in
// config.json and built into its own folder under app data, which only Loadout writes.
import { LoadoutName, type AppConfigV1, type Loadout, type LoadoutMember } from "../config/config.ts";
import type { CallOpts } from "../git/git.ts";
import { checkItems, installItem } from "../install/apply.ts";
import { discardPlan, planEntries, type InstallCtx } from "../install/plan.ts";
import { err, ok, type Entry, type EntryType, type Result } from "../model/model.ts";
import { createReceiptStore } from "../receipts/receipts.ts";
import { loadRegistry, type Registry } from "../registry/registry.ts";
import { destFor } from "../scan/scan.ts";

export type { LoadoutMember };

type LoadoutCtx = Pick<InstallCtx, "host" | "config">;

export interface LoadoutRecord {
  name: string;
  /** each with the catalog it resolves to; null when no catalog defines it */
  members: (LoadoutMember & { resolvesTo: string | null })[];
}

export interface SaveLoadoutRequest {
  name: string;
  members: LoadoutMember[];
  /** replace the loadout of that name; without it, an existing name is DUPLICATE */
  replace?: boolean;
}

export interface SaveLoadoutPlan {
  name: string;
  members: LoadoutMember[];
  /** the loadout as saved when planned, null for a new one; apply refuses if it changed since */
  previous: Loadout | null;
  /** members no catalog defines; they are saved anyway */
  unknown: LoadoutMember[];
}

export interface BuildReport {
  /** what is now in the folder: the members, and the entries they require */
  built: { type: EntryType; name: string; dest: string; requiredBy: string[] }[];
  /** what didn't land, and why; a member built before keeps that copy */
  failed: { type: EntryType; name: string; requiredBy: string[]; reason: string }[];
  /** copies of what left the loadout */
  removed: { type: EntryType; name: string; dest: string }[];
}

export type SaveLoadoutResult = LoadoutRecord & { build: BuildReport };

export interface DeleteLoadoutPlan {
  name: string;
  /** the loadout as saved when planned; apply refuses if it changed since */
  previous: Loadout;
  folder: string;
}

export const loadoutDir = (appData: string, name: string) => `${appData}/loadouts/${name}`;

/** The entry a member stands for: by type and name through catalog order and pins, or in the catalog it names. */
function entryOf(registry: Registry, member: LoadoutMember): Entry | null {
  const scope = registry.searchScope(member.catalog);
  if (!scope.ok) return null;
  return scope.value.find((e) => e.type === member.type && e.name === member.name) ?? null;
}

const sameLoadout = (a: Loadout | null | undefined, b: Loadout | null) => JSON.stringify(a ?? null) === JSON.stringify(b);

async function savedLoadouts(ctx: LoadoutCtx): Promise<Result<Record<string, Loadout>>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  return ok(loaded.value.config.loadouts ?? {});
}

function recordOf(registry: Registry, name: string, loadout: Loadout): LoadoutRecord {
  return { name, members: loadout.members.map((m) => ({ ...m, resolvesTo: entryOf(registry, m)?.catalog ?? null })) };
}

export async function listLoadouts(ctx: LoadoutCtx): Promise<Result<LoadoutRecord[]>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const byName = Object.entries(loaded.value.config.loadouts ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return ok(byName.map(([name, loadout]) => recordOf(registry, name, loadout)));
}

export async function planSaveLoadout(ctx: LoadoutCtx, req: SaveLoadoutRequest): Promise<Result<SaveLoadoutPlan>> {
  const { name } = req;
  // Only the saved fields: members handed back from listLoadouts() carry resolvesTo, which the strict config schema refuses.
  const members = req.members.map((m) => ({ type: m.type, name: m.name, ...(m.catalog !== undefined && { catalog: m.catalog }) }));
  if (!LoadoutName.safeParse(name).success) {
    return err({ code: "REFUSED", message: `'${name}' can't name a loadout: use lowercase letters and digits, with single hyphens between them` });
  }
  const seen = new Set<string>();
  for (const m of members) {
    const key = `${m.type}:${m.name}`;
    if (seen.has(key)) return err({ code: "DUPLICATE", message: `the ${m.type} '${m.name}' is in '${name}' twice; a loadout holds one copy of each` });
    seen.add(key);
  }

  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const previous = loaded.value.config.loadouts?.[name] ?? null;
  if (previous !== null && !req.replace) return err({ code: "DUPLICATE", message: `a loadout named '${name}' already exists` });
  if (previous === null && req.replace) return err({ code: "NOT_FOUND", message: `no loadout named '${name}' to replace` });

  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const unknown = members.filter((m) => entryOf(registry, m) === null);
  return ok({ name, members, previous, unknown });
}

/** Saves the loadout, then builds its folder; a build that fails leaves the loadout saved. */
export async function applySaveLoadout(ctx: InstallCtx, plan: SaveLoadoutPlan, opts: CallOpts = {}): Promise<Result<SaveLoadoutResult>> {
  const saved = await savedLoadouts(ctx);
  if (!saved.ok) return saved;
  if (!sameLoadout(saved.value[plan.name], plan.previous)) {
    return err({ code: "STALE_PLAN", message: `the loadout '${plan.name}' changed since this was planned; plan it again` });
  }
  const loadout: Loadout = { members: plan.members };
  const updated = await ctx.config.updateConfig((c) => ({ ...c, loadouts: { ...c.loadouts, [plan.name]: loadout } }));
  if (!updated.ok) return updated;
  const registry = await loadRegistry(ctx.host, updated.value);
  const record = recordOf(registry, plan.name, loadout);
  const build = await buildLoadout(ctx, plan.name, loadout, opts);
  if (!build.ok) return err({ ...build.error, message: `'${plan.name}' is saved, but its folder couldn't be built: ${build.error.message}` }, build.warnings);
  return ok({ ...record, build: build.value }, build.warnings);
}

/**
 * Installs the members and what they require into the loadout's folder, with the loadout's own
 * receipts, then removes what left. Unlike a global install, an item that fails doesn't stop the
 * rest. The folder is Loadout's alone, so what it holds without a receipt, or edited since, is replaced.
 */
export async function buildLoadout(ctx: InstallCtx, name: string, loadout: Loadout, opts: CallOpts = {}): Promise<Result<BuildReport>> {
  const { host } = ctx;
  const folder = loadoutDir(host.paths.appData, name);
  const into: InstallCtx = { ...ctx, root: folder, receipts: createReceiptStore(host, `${folder}/receipts.json`) };
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(host, loaded.value.config);

  const report: BuildReport = { built: [], failed: [], removed: [] };
  const targets: Entry[] = [];
  for (const member of loadout.members) {
    const entry = entryOf(registry, member);
    if (entry === null) report.failed.push({ type: member.type, name: member.name, requiredBy: [], reason: "no catalog defines it" });
    else targets.push(entry);
  }

  const plan = await planEntries(into, registry, loaded.value.config, targets, opts);
  if (!plan.ok) return plan;
  try {
    const unreceipted = new Set(plan.value.items.filter((i) => i.needsConsent).map((i) => i.dest));
    const checked = await checkItems(into, plan.value.items, unreceipted);
    if (!checked.ok) return checked;
    for (const item of plan.value.items) {
      const failure = item.status === "ready" ? await installItem(into, item) : (item.reason ?? item.status);
      if (failure === null) report.built.push({ type: item.type, name: item.name, dest: item.dest, requiredBy: item.requiredBy });
      else report.failed.push({ type: item.type, name: item.name, requiredBy: item.requiredBy, reason: failure });
    }
  } finally {
    await discardPlan(host, plan.value);
  }

  // A member that can't be resolved keeps its copy, so a catalog that can't be read doesn't empty the loadout.
  const kept = new Set([...plan.value.items.map((i) => i.dest), ...loadout.members.map((m) => destFor(folder, m.type, m.name))]);
  const receipts = await into.receipts.all();
  if (!receipts.ok) return receipts;
  for (const r of receipts.value) {
    if (kept.has(r.dest)) continue;
    if (await host.fs.exists(r.dest)) {
      await host.fs.remove(r.dest, { recursive: true });
      host.audit({ kind: "fs", op: "delete", path: r.dest });
    }
    const dropped = await into.receipts.delete(r.dest);
    if (!dropped.ok) return dropped;
    report.removed.push({ type: r.type, name: r.name, dest: r.dest });
  }
  return ok(report, [...plan.warnings, ...receipts.warnings]);
}

export async function planDeleteLoadout(ctx: LoadoutCtx, name: string): Promise<Result<DeleteLoadoutPlan>> {
  const saved = await savedLoadouts(ctx);
  if (!saved.ok) return saved;
  const previous = saved.value[name];
  if (previous === undefined) {
    const names = Object.keys(saved.value).sort().join(", ") || "none";
    return err({ code: "NOT_FOUND", message: `no loadout named '${name}' (loadouts: ${names})` });
  }
  return ok({ name, previous, folder: loadoutDir(ctx.host.paths.appData, name) });
}

/** The folder goes first, so a failed config write leaves a saved loadout with nothing built rather than a launchable folder nobody lists. */
export async function applyDeleteLoadout(ctx: LoadoutCtx, plan: DeleteLoadoutPlan): Promise<Result<{ name: string; removedFolder: boolean }>> {
  const { host } = ctx;
  const saved = await savedLoadouts(ctx);
  if (!saved.ok) return saved;
  if (!sameLoadout(saved.value[plan.name], plan.previous)) {
    return err({ code: "STALE_PLAN", message: `the loadout '${plan.name}' changed since this was planned; plan it again` });
  }

  const folder = loadoutDir(host.paths.appData, plan.name);
  const removedFolder = await host.fs.exists(folder);
  if (removedFolder) {
    await host.fs.remove(folder, { recursive: true });
    host.audit({ kind: "fs", op: "delete", path: folder });
  }

  const updated = await ctx.config.updateConfig((c) => {
    const remaining = Object.fromEntries(Object.entries(c.loadouts ?? {}).filter(([n]) => n !== plan.name));
    const next: AppConfigV1 = { ...c, loadouts: remaining };
    // Absent means none, so the last delete leaves the file as it was before the first save.
    if (Object.keys(remaining).length === 0) delete next.loadouts;
    return next;
  });
  if (!updated.ok) return updated;
  return ok({ name: plan.name, removedFolder });
}
