// Uninstall (UNIN-01, UNIN-02 rebuild, Q17 A). Only the global destination of each name is considered.
// Content Loadout didn't install is never deleted unless the request names its exact path; a receipt
// whose destination is already gone is pruned. Uninstalling a skill or prompt also deletes its
// `skillOverrides` entry, so an "off" can't go on hiding a future skill of the same name.
import type { ClaudeSettings } from "../claudeSettings/settings.ts";
import type { ConfigStore } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type EntryType, type Result, type Warning } from "../model/model.ts";
import type { ReceiptStore } from "../receipts/receipts.ts";
import { loadRegistry, type ResolveErr } from "../registry/registry.ts";
import { destFor } from "../scan/scan.ts";

export interface UninstallCtx {
  host: Host;
  config: ConfigStore;
  receipts: ReceiptStore;
  settings: ClaudeSettings;
}

export interface UninstallItem {
  type: EntryType;
  name: string;
  dest: string;
  /** "deleted": files and receipt gone; "pruned": nothing was there, the receipt was dropped; "absent": nothing to do;
   * "refused": unmanaged content not named in forcePaths */
  outcome: "deleted" | "pruned" | "absent" | "refused";
  /** Q17 A: the override value removed along with it */
  overrideRemoved: string | null;
}

export async function uninstall(
  ctx: UninstallCtx,
  req: { names: string[]; forcePaths?: string[]; /** a name's type when the caller knows it, e.g. remove --purge */ types?: Partial<Record<string, EntryType>> },
): Promise<Result<{ items: UninstallItem[] }, ResolveErr>> {
  const { host } = ctx;
  const home = host.paths.home;
  const force = new Set(req.forcePaths ?? []);
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(host, loaded.value.config);
  const receipts = await ctx.receipts.all();
  if (!receipts.ok) return receipts;
  const byDest = new Map(receipts.value.map((r) => [r.dest, r]));

  // Every name resolves before anything is deleted (RES-05): the catalog's entry, else what was installed under that name.
  const targets: { type: EntryType; name: string; dest: string }[] = [];
  for (const name of req.names) {
    const winner = req.types?.[name] ?? registry.winners().get(name)?.type;
    const known = (["skill", "prompt", "agent"] as const).filter((t) => byDest.has(destFor(home, t, name)));
    let type: EntryType | undefined = winner ?? known[0];
    if (type === undefined) {
      for (const t of ["skill", "prompt", "agent"] as const) if (type === undefined && (await host.fs.exists(destFor(home, t, name)))) type = t;
    }
    if (type === undefined) {
      return err({ code: "NOT_FOUND", message: `nothing named '${name}' is installed or in a catalog`, query: name, candidates: registry.candidates(name) });
    }
    targets.push({ type, name, dest: destFor(home, type, name) });
  }

  const items: UninstallItem[] = [];
  for (const { type, name, dest } of targets) {
    const receipt = byDest.get(dest) ?? null;
    const present = await host.fs.exists(dest);
    let outcome: UninstallItem["outcome"];
    if (!present) {
      outcome = receipt ? "pruned" : "absent";
    } else if (receipt === null && !force.has(dest)) {
      outcome = "refused";
    } else {
      await host.fs.remove(dest, { recursive: true });
      host.audit({ kind: "fs", op: "delete", path: dest });
      outcome = "deleted";
    }
    if (receipt && outcome !== "refused") {
      const dropped = await ctx.receipts.delete(dest);
      if (!dropped.ok) return dropped;
    }
    items.push({ type, name, dest, outcome, overrideRemoved: null });
  }

  // Q17 A, in one settings write. The files are already gone, so a settings failure is a warning, not an error.
  const warnings: Warning[] = [];
  const deleted = items.filter((i) => i.outcome === "deleted" && i.type !== "agent");
  const leftBehind = (why: string) => warnings.push({ message: `uninstalled, but the skillOverrides entries were left: ${why}` });
  if (deleted.length > 0) {
    const current = await ctx.settings.readSkillOverrides();
    if (!current.ok) leftBehind(current.error.message);
    else {
      const set = deleted.filter((i) => current.value.has(i.name));
      const edited = set.length > 0 ? await ctx.settings.editSkillOverrides(Object.fromEntries(set.map((i) => [i.name, null]))) : null;
      if (edited && !edited.ok) leftBehind(edited.error.message);
      else for (const i of set) i.overrideRemoved = current.value.get(i.name)!;
    }
  }
  return ok({ items }, warnings);
}
