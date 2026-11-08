// How the Loadouts screen puts a loadout, a clash and a save into words.
import type { Library, LoadoutRecord } from "@loadout/core";

type Clash = Extract<Awaited<ReturnType<Library["launchCommand"]>>, { ok: true }>["value"]["clashes"][number];
type Saved = Extract<Awaited<ReturnType<Library["applySaveLoadout"]>>, { ok: true }>["value"];
type LoadoutSynced = Extract<Awaited<ReturnType<Library["applySync"]>>, { ok: true }>["value"]["loadouts"][number];
type Outcome = { kind: "success" | "warning"; message: string; detail?: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The member count, then what isn't built and current: "3 members · 1 out of date · 1 not built". */
export function loadoutSummary(loadout: LoadoutRecord): string {
  const count = (state: LoadoutRecord["members"][number]["state"]) => loadout.members.filter((m) => m.state === state).length;
  const total = loadout.members.length;
  const parts = [`${total} ${plural(total, "member", "members")}`];
  if (count("stale")) parts.push(`${count("stale")} out of date`);
  if (count("missing")) parts.push(`${count("missing")} not built`);
  if (count("failed")) parts.push(`${count("failed")} in no catalog`);
  const allBuilt = total > 0 && parts.length === 1;
  if (allBuilt) parts.push("all built");
  return parts.join(" · ");
}

/** Sync rebuilds what's out of date and builds what's missing; a member no catalog defines needs an edit instead. */
export function needsSync(loadout: LoadoutRecord): boolean {
  return loadout.members.some((m) => m.state === "stale" || m.state === "missing");
}

export function clashText(clash: Clash): string {
  const { name, outcome } = clash;
  if (outcome === "prefixed") return `Your global ${clash.with} keeps /${name}; in a session this one is /${clash.sessionName}.`;
  if (outcome === "shadows") return `Takes /${name} in a session, so your global prompt of that name won't load there.`;
  if (outcome === "unknown") return `An agent named ${name} is installed globally; which one Claude Code uses hasn't been checked.`;
  // Hidden happens to a skill alone: an override is by name, so a global skill turned off hides it too.
  return `Won't load: your global skill ${name} is turned off, and that hides this one too.`;
}

const keyOf = (item: { type: string; name: string }) => `${item.type}:${item.name}`;

/** The view's banner after syncing one loadout; `done` is absent when nothing needed syncing. A moved prompt was synced into its new place and removed from its old one. */
export function syncedOutcome(name: string, done: LoadoutSynced | undefined): Outcome {
  const synced = done?.synced ?? [];
  const removed = done?.removed ?? [];
  const failed = done?.failed ?? [];
  const placedAgain = new Set(synced.map(keyOf));
  const moved = removed.filter((r) => placedAgain.has(keyOf(r))).length;
  const parts: string[] = [];
  if (synced.length - moved) parts.push(`${synced.length - moved} updated`);
  if (moved) parts.push(`${moved} moved`);
  if (removed.length - moved) parts.push(`${removed.length - moved} removed`);
  const did = parts.length ? `Synced ${name}: ${parts.join(", ")}` : `Synced ${name}`;
  if (failed.length) {
    const detail = failed.map((f) => `${f.name}: ${f.reason}`).join("\n");
    return { kind: "warning", message: `${did}, but ${failed.length} didn't update.`, detail };
  }
  if (!parts.length) return { kind: "success", message: `${name} is already up to date.` };
  return { kind: "success", message: `${did}.` };
}

/** The view's banner after a save, which builds: what landed, or what didn't and why. */
export function savedOutcome(result: Saved): Outcome {
  const { built, failed, removed } = result.build;
  if (failed.length === 0) {
    const parts = [`${built.length} ${plural(built.length, "entry", "entries")} built`];
    if (removed.length) parts.push(`${removed.length} removed`);
    return { kind: "success", message: `Saved ${result.name}: ${parts.join(", ")}.` };
  }
  const lines = failed.map((f) => `${f.name}${f.requiredBy.length ? ` (required by ${f.requiredBy.join(", ")})` : ""}: ${f.reason}`);
  return {
    kind: "warning",
    message: `Saved ${result.name}, but ${failed.length} ${plural(failed.length, "entry", "entries")} didn't build. The rest are ready; Sync tries the others again.`,
    detail: lines.join("\n"),
  };
}
