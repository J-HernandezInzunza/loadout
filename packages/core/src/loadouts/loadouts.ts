// Loadouts: named sets of catalog entries a user brings into one Claude Code session. Each is saved in
// config.json and built into its own folder under app data, which only Loadout writes.
import type { ClaudeSettings } from "../claudeSettings/settings.ts";
import { LoadoutName, type AppConfigV1, type Loadout, type LoadoutMember } from "../config/config.ts";
import { resolveDeps } from "../deps/deps.ts";
import type { CallOpts } from "../git/git.ts";
import { createOperation, type Operation } from "../git/operation.ts";
import { checkItems, installItem } from "../install/apply.ts";
import { buildItem, catalogKeys, discardPlan, planEntries, type InstallCtx, type PlanItem } from "../install/plan.ts";
import { err, ok, type Entry, type EntryType, type Result, type Warning } from "../model/model.ts";
import { createReceiptStore, type ReceiptV2 } from "../receipts/receipts.ts";
import { loadRegistry, type Registry } from "../registry/registry.ts";
import { destFor, destState, scanInstallDirs } from "../scan/scan.ts";
import { checkUpdate, isStale, localSourceMoved } from "../update/update.ts";

export type { LoadoutMember };

type LoadoutCtx = Pick<InstallCtx, "host" | "config">;

/**
 * failed: no catalog defines the member. missing: nothing it built is in the folder. stale: the copy
 * isn't what its catalog entry would build now (repointed, edited in the folder, or its source moved).
 */
export type MemberState = "built" | "stale" | "missing" | "failed";

export interface LoadoutRecord {
  name: string;
  /** `loadout run <name>` */
  run: string;
  /** the same launch without the `loadout` command: `claude --add-dir='<folder>'`, quoted for a shell */
  command: string;
  /** each with the catalog it resolves to (null when no catalog defines it) and the state of its copy */
  members: (LoadoutMember & { resolvesTo: string | null; state: MemberState })[];
}

type Ref = Pick<Entry, "type" | "name" | "catalog">;

/** What Sync does for one loadout: like an install's sync, but what's missing or unreceipted is built too. */
export interface LoadoutSyncPlan {
  name: string;
  items: PlanItem[];
  upToDate: (Ref & { status: "up-to-date" | "unmoved" })[];
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

/** A member that shares its name with something Claude Code loads from ~/.claude, and what a session makes of it. */
export interface Clash {
  type: EntryType;
  name: string;
  /** the type of the global item that decides the outcome */
  with: EntryType;
  /**
   * prefixed: the member loads as `<loadout>:<name>`, the global skill keeps the name.
   * shadows: the member takes the name, and the global prompt is hidden in that session.
   * hidden: the member doesn't load (a global prompt or skill wins, or the global skill is turned off).
   * unknown: an agent of that name is installed; which one Claude Code uses hasn't been checked.
   */
  outcome: "prefixed" | "shadows" | "hidden" | "unknown";
  /** the member's name in the session; null when it doesn't load or isn't known */
  sessionName: string | null;
}

export interface LaunchCommand {
  name: string;
  /** through the `loadout` command shipped in the app */
  run: string;
  /** the same launch without it, for a .dmg install */
  command: string;
  clashes: Clash[];
}

const nameRefused = (name: string) =>
  err({ code: "REFUSED" as const, message: `'${name}' can't name a loadout: use lowercase letters and digits, with single hyphens between them` });

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

/** Single quotes, each one inside written '\'' so the shell gives the path back as one argument. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** What a session makes of each member named like a global item that loads; bundled and plugin items aren't on disk, so aren't known. */
export function clashesOf(loadout: string, members: LoadoutMember[], global: { type: EntryType; name: string; off: boolean }[]): Clash[] {
  const clashes: Clash[] = [];
  for (const m of members) {
    const skill = global.find((g) => g.type === "skill" && g.name === m.name);
    const prompt = global.find((g) => g.type === "prompt" && g.name === m.name);
    const agent = global.find((g) => g.type === "agent" && g.name === m.name);
    const clash = { type: m.type, name: m.name };
    if (m.type === "skill") {
      // An override is by name, so turning the global skill off hides the prefixed copy too.
      if (skill?.off) clashes.push({ ...clash, with: "skill", outcome: "hidden", sessionName: null });
      else if (skill) clashes.push({ ...clash, with: "skill", outcome: "prefixed", sessionName: `${loadout}:${m.name}` });
      else if (prompt) clashes.push({ ...clash, with: "prompt", outcome: "shadows", sessionName: m.name });
    } else if (m.type === "prompt") {
      const winner = prompt ?? skill;
      if (winner) clashes.push({ ...clash, with: winner.type, outcome: "hidden", sessionName: null });
    } else if (agent) {
      clashes.push({ ...clash, with: "agent", outcome: "unknown", sessionName: null });
    }
  }
  return clashes;
}

function commandsFor(appData: string, name: string): Pick<LaunchCommand, "run" | "command"> {
  return { run: `loadout run ${name}`, command: `claude --add-dir=${shellQuote(loadoutDir(appData, name))}` };
}

/** With `members`, previews a loadout not saved yet (or as it would be after an edit) under `name`. */
export async function launchCommand(
  ctx: LoadoutCtx & Pick<InstallCtx, "receipts"> & { settings: ClaudeSettings },
  name: string,
  opts: { members?: LoadoutMember[] } = {},
): Promise<Result<LaunchCommand>> {
  const { host } = ctx;
  if (!LoadoutName.safeParse(name).success) return nameRefused(name);
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const config = loaded.value.config;
  const members = opts.members ?? config.loadouts?.[name]?.members;
  if (members === undefined) {
    const names = Object.keys(config.loadouts ?? {}).sort().join(", ") || "none";
    return err({ code: "NOT_FOUND", message: `no loadout named '${name}' (loadouts: ${names})` });
  }

  const legacy = config.imported?.installs;
  const scanned = await scanInstallDirs(host, ctx.receipts, legacy === undefined ? {} : { legacyInstalls: legacy });
  if (!scanned.ok) return scanned;
  const overrides = await ctx.settings.readSkillOverrides();
  const warnings: Warning[] = [...scanned.warnings];
  if (!overrides.ok) warnings.push({ message: `which skills are off is unknown, so a clash with one may be wrong: ${overrides.error.message}` });
  const off = overrides.ok ? overrides.value : new Map<string, string>();
  // A prompt namespace folder adds `/<ns>:<cmd>`, which no member's name can take.
  const loadable = scanned.value.items.filter((i) => i.loadable && (i.type !== "prompt" || i.path.endsWith(".md")));
  const global = loadable.map((i) => ({ type: i.type, name: i.name, off: i.type === "skill" && off.get(i.name) === "off" }));

  return ok({ name, ...commandsFor(host.paths.appData, name), clashes: clashesOf(name, members, global) }, warnings);
}

/** The install context for a loadout's folder: its root and its own receipts. */
export function loadoutCtx(ctx: InstallCtx, name: string): InstallCtx {
  const folder = loadoutDir(ctx.host.paths.appData, name);
  return { ...ctx, root: folder, receipts: createReceiptStore(ctx.host, `${folder}/receipts.json`) };
}

/** Without `op`, a remote source that moved isn't noticed: that takes the network. */
async function memberState(into: InstallCtx, byDest: Map<string, ReceiptV2>, member: LoadoutMember, entry: Entry | null, op: Operation | null): Promise<MemberState> {
  const { host } = into;
  if (entry === null) return "failed";
  const dest = destFor(into.root!, member.type, member.name);
  const receipt = byDest.get(dest) ?? null;
  const present = await host.fs.exists(dest);
  if (receipt === null || !present) return "missing";
  if (receipt.source !== entry.source) return "stale";
  const copy = await destState(host, dest, receipt);
  if (copy.state !== "installed") return "stale";
  if (await localSourceMoved(host, entry, receipt)) return "stale";
  const remoteMoved = op !== null && (await isStale({ host, op, receipts: into.receipts }, entry, receipt));
  if (remoteMoved) return "stale";
  return "built";
}

async function recordOf(ctx: InstallCtx, registry: Registry, name: string, loadout: Loadout, op: Operation | null): Promise<Result<LoadoutRecord>> {
  const into = loadoutCtx(ctx, name);
  const receipts = await into.receipts.all();
  if (!receipts.ok) return receipts;
  const byDest = new Map(receipts.value.map((r) => [r.dest, r]));
  const members: LoadoutRecord["members"] = [];
  for (const m of loadout.members) {
    const entry = entryOf(registry, m);
    members.push({ ...m, resolvesTo: entry?.catalog ?? null, state: await memberState(into, byDest, m, entry, op) });
  }
  return ok({ name, ...commandsFor(ctx.host.paths.appData, name), members }, receipts.warnings);
}

/** With `checkRemote`, each remote source is asked whether it moved, as list() does. */
export async function listLoadouts(ctx: InstallCtx, opts: { checkRemote?: boolean } = {}): Promise<Result<LoadoutRecord[]>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const byName = Object.entries(loaded.value.config.loadouts ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const op = opts.checkRemote ? await createOperation(ctx.host, ctx.git) : null;
  try {
    const records: LoadoutRecord[] = [];
    const warnings: Warning[] = [];
    for (const [name, loadout] of byName) {
      const record = await recordOf(ctx, registry, name, loadout, op);
      if (!record.ok) return record;
      records.push(record.value);
      warnings.push(...record.warnings);
    }
    return ok(records, warnings);
  } finally {
    await op?.dispose();
  }
}

/**
 * Sync for one loadout: each resolved member's closure, checked against the loadout's receipts as Sync
 * checks installs (UPD-04/05 skips what is provably unchanged). What's missing or unreceipted is built,
 * since only Loadout writes the folder.
 */
export async function planLoadoutSync(
  ctx: InstallCtx,
  op: Operation,
  registry: Registry,
  name: string,
  loadout: Loadout,
  req: { catalog?: string; force?: boolean },
  opts: CallOpts = {},
): Promise<Result<LoadoutSyncPlan>> {
  const { host } = ctx;
  const into = loadoutCtx(ctx, name);
  const receipts = await into.receipts.all();
  if (!receipts.ok) return receipts;
  const byDest = new Map(receipts.value.map((r) => [r.dest, r]));
  const keys = await catalogKeys(host, registry);
  const warnings: Warning[] = [...receipts.warnings];

  const plan: LoadoutSyncPlan = { name, items: [], upToDate: [] };
  const seen = new Set<string>();
  for (const member of loadout.members) {
    const target = entryOf(registry, member);
    const isSynced = target !== null && (req.catalog === undefined || target.catalog === req.catalog);
    if (!isSynced) continue;
    const deps = resolveDeps(registry.entriesOf(target.catalog), target);
    warnings.push(...deps.warnings);
    for (const entry of deps.order) {
      const key = `${entry.type}:${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dest = destFor(into.root!, entry.type, entry.name);
      const receipt = byDest.get(dest) ?? null;
      const state = await destState(host, dest, receipt);
      const hasCopy = state.state === "installed" || state.state === "drifted";
      if (hasCopy) {
        const check = await checkUpdate({ host, op, receipts: into.receipts }, entry, receipt, { force: req.force ?? false });
        if (check.status !== "changed") {
          plan.upToDate.push({ type: entry.type, name: entry.name, catalog: entry.catalog, status: check.status });
          continue;
        }
      }
      const requiredBy = entry === target ? [] : [target.name];
      plan.items.push(await buildItem(into, op, entry, state, { catalogKey: keys.get(entry.catalog)!, requiredBy, provenance: registry.overrideSplit(entry), opts }));
    }
  }
  return ok(plan, warnings);
}

export async function planSaveLoadout(ctx: LoadoutCtx, req: SaveLoadoutRequest): Promise<Result<SaveLoadoutPlan>> {
  const { name } = req;
  // Only the saved fields: members handed back from listLoadouts() carry resolvesTo, which the strict config schema refuses.
  const members = req.members.map((m) => ({ type: m.type, name: m.name, ...(m.catalog !== undefined && { catalog: m.catalog }) }));
  if (!LoadoutName.safeParse(name).success) return nameRefused(name);
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
  const build = await buildLoadout(ctx, plan.name, loadout, opts);
  if (!build.ok) return err({ ...build.error, message: `'${plan.name}' is saved, but its folder couldn't be built: ${build.error.message}` }, build.warnings);
  const registry = await loadRegistry(ctx.host, updated.value);
  const record = await recordOf(ctx, registry, plan.name, loadout, null);
  if (!record.ok) return record;
  return ok({ ...record.value, build: build.value }, [...build.warnings, ...record.warnings]);
}

/**
 * Installs the members and what they require into the loadout's folder, with the loadout's own
 * receipts, then removes what left. Unlike a global install, an item that fails doesn't stop the
 * rest. The folder is Loadout's alone, so what it holds without a receipt, or edited since, is replaced.
 */
export async function buildLoadout(ctx: InstallCtx, name: string, loadout: Loadout, opts: CallOpts = {}): Promise<Result<BuildReport>> {
  const { host } = ctx;
  const folder = loadoutDir(host.paths.appData, name);
  const into = loadoutCtx(ctx, name);
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
