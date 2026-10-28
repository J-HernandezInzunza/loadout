// Turning skills and prompts on and off through Claude Code's own `skillOverrides` (architecture.md
// §4.5). Files never move. The key is always the entry name, which is the installed folder or file
// name (rule 1, spikes.md S10); "off" sets it and "on" deletes it. Agents aren't covered (Q15 A).
// Unmanaged items toggle the same way (rule 6): the setting doesn't care who installed the files.
import type { ConfigStore } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type EntryType, type Result } from "../model/model.ts";
import { loadRegistry, type ResolveErr } from "../registry/registry.ts";
import { destFor } from "../scan/scan.ts";
import type { ClaudeSettings } from "./settings.ts";

/** macOS's system config directory (Claude Code's docs); MDM may also set a plist domain the core can't read. */
export const managedSettingsFile = "/Library/Application Support/ClaudeCode/managed-settings.json";

export interface ToggleCtx {
  host: Host;
  config: ConfigStore;
  settings: ClaudeSettings;
}

export interface ToggleReport {
  changed: { name: string; type: EntryType; state: "on" | "off" }[];
  /** already in the requested state */
  unchanged: string[];
  /** Q14 A: set to a value Loadout doesn't manage (name-only, user-invocable-only); left alone */
  readOnly: { name: string; value: string }[];
}

/** Which kind of thing `name` is: the catalog's winning entry, else whatever is installed under that name. */
async function kindOf(host: Host, name: string, catalogType: EntryType | undefined): Promise<EntryType | null> {
  if (catalogType !== undefined) return catalogType;
  for (const type of ["skill", "prompt", "agent"] as const) {
    if (await host.fs.exists(destFor(host.paths.home, type, name))) return type;
  }
  return null;
}

export async function setSkillState(ctx: ToggleCtx, names: string[], state: "on" | "off"): Promise<Result<ToggleReport, ResolveErr>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const winners = registry.winners();

  // Every name is checked before anything is written (RES-05).
  const items: { name: string; type: EntryType }[] = [];
  for (const name of names) {
    const type = await kindOf(ctx.host, name, winners.get(name)?.type);
    if (type === null) {
      return err({ code: "NOT_FOUND", message: `nothing named '${name}' in a catalog or installed`, query: name, candidates: registry.candidates(name) });
    }
    if (type === "agent") return err({ code: "REFUSED", message: `'${name}' is an agent; Loadout turns skills and prompts on and off, not agents yet` });
    items.push({ name, type });
  }

  const current = await ctx.settings.readSkillOverrides();
  if (!current.ok) return current;
  const report: ToggleReport = { changed: [], unchanged: [], readOnly: [] };
  const changes: Record<string, "off" | null> = {};
  for (const { name, type } of items) {
    const value = current.value.get(name);
    if (value === "name-only" || value === "user-invocable-only") {
      report.readOnly.push({ name, value });
    } else if (state === "off" ? value === "off" : value === undefined) {
      report.unchanged.push(name);
    } else {
      // A missing key means "on", so turning on deletes it, an explicit "on" included.
      changes[name] = state === "off" ? "off" : null;
      report.changed.push({ name, type, state });
    }
  }
  if (Object.keys(changes).length > 0) {
    const edited = await ctx.settings.editSkillOverrides(changes);
    if (!edited.ok) return edited;
  }
  return ok(report);
}

/** Rule 4: overrides set by managed settings, which sit above the user's; empty when the file is absent or unreadable. */
export async function managedSkillOverrides(host: Host, file = managedSettingsFile): Promise<Map<string, string>> {
  try {
    const data = JSON.parse(await host.fs.readText(file)) as { skillOverrides?: unknown };
    const overrides = data.skillOverrides;
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return new Map();
    return new Map(Object.entries(overrides).map(([k, v]) => [k, String(v)]));
  } catch {
    return new Map();
  }
}
