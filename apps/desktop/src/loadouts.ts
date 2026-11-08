// How the Loadouts screen puts a loadout, a clash and a save into words.
import type { Library, LoadoutRecord } from "@loadout/core";

type Clash = Extract<Awaited<ReturnType<Library["launchCommand"]>>, { ok: true }>["value"]["clashes"][number];
type Saved = Extract<Awaited<ReturnType<Library["applySaveLoadout"]>>, { ok: true }>["value"];

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

/** The view's banner after a save, which builds: what landed, or what didn't and why. */
export function savedOutcome(result: Saved): { kind: "success" | "warning"; message: string; detail?: string } {
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
