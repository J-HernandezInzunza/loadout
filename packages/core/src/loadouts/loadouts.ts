// Loadouts: named sets of catalog entries a user brings into one Claude Code session. Each is saved in
// config.json and built into its own folder under app data, which only Loadout writes.
import { LoadoutName, type AppConfigV1, type ConfigStore, type Loadout, type LoadoutMember } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";
import { loadRegistry, type Registry } from "../registry/registry.ts";

export type { LoadoutMember };

interface LoadoutCtx {
  host: Host;
  config: ConfigStore;
}

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

export interface DeleteLoadoutPlan {
  name: string;
  /** the loadout as saved when planned; apply refuses if it changed since */
  previous: Loadout;
  folder: string;
}

export const loadoutDir = (appData: string, name: string) => `${appData}/loadouts/${name}`;

function resolvesTo(registry: Registry, member: LoadoutMember): string | null {
  const scope = registry.searchScope(member.catalog);
  if (!scope.ok) return null;
  const found = scope.value.find((e) => e.type === member.type && e.name === member.name);
  return found?.catalog ?? null;
}

const sameLoadout = (a: Loadout | null | undefined, b: Loadout | null) => JSON.stringify(a ?? null) === JSON.stringify(b);

async function savedLoadouts(ctx: LoadoutCtx): Promise<Result<Record<string, Loadout>>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  return ok(loaded.value.config.loadouts ?? {});
}

function recordOf(registry: Registry, name: string, loadout: Loadout): LoadoutRecord {
  return { name, members: loadout.members.map((m) => ({ ...m, resolvesTo: resolvesTo(registry, m) })) };
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
  const unknown = members.filter((m) => resolvesTo(registry, m) === null);
  return ok({ name, members, previous, unknown });
}

export async function applySaveLoadout(ctx: LoadoutCtx, plan: SaveLoadoutPlan): Promise<Result<LoadoutRecord>> {
  const saved = await savedLoadouts(ctx);
  if (!saved.ok) return saved;
  if (!sameLoadout(saved.value[plan.name], plan.previous)) {
    return err({ code: "STALE_PLAN", message: `the loadout '${plan.name}' changed since this was planned; plan it again` });
  }
  const loadout: Loadout = { members: plan.members };
  const updated = await ctx.config.updateConfig((c) => ({ ...c, loadouts: { ...c.loadouts, [plan.name]: loadout } }));
  if (!updated.ok) return updated;
  const registry = await loadRegistry(ctx.host, updated.value);
  return ok(recordOf(registry, plan.name, loadout));
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
