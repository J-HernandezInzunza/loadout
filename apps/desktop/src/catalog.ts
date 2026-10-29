// Wording, ranking and colour for the catalog list; what the rows are (winners, provenance, install state)
// is decided in the core and read off its records.
import { groupByName, type CatalogRow, type EntryRecord, type Library, type PlanItem } from "@loadout/core";

const HUES = [211, 275, 25, 320];

/** A stable colour per catalog, so origin reads at a glance without a legend. */
export function catalogHue(precedence: number): number {
  return HUES[(precedence - 1) % HUES.length]!;
}

/** Which tab the list shows: every catalog, one of them, or what is switched off. */
export type Tab = { kind: "all" } | { kind: "catalog"; id: string } | { kind: "disabled" };

/** An entry copy as one card: its install badge, and the catalogs it beats where that is worth saying. */
export interface Row {
  entry: EntryRecord;
  status: string;
  tone: "installed" | "absent" | "attention" | "disabled";
  overrides: string[];
}

export const SESSION_TIMING =
  "Claude Code loads skills when a session starts, so this takes effect in your next session, not one you already have open.";

/** The badge for a copy, from the state the core read at its destination. */
export function installStatus(entry: EntryRecord): Pick<Row, "status" | "tone"> {
  if (entry.disabled && entry.installed) return { status: "disabled", tone: "disabled" };
  switch (entry.state) {
    case "installed":
      return { status: "installed", tone: "installed" };
    case "unmanaged":
      return { status: "installed outside Loadout", tone: "installed" };
    case "drifted":
      return { status: "edited locally", tone: "attention" };
    case "stale":
      return { status: "update available", tone: "attention" };
    case "not_installed":
      return { status: "not installed", tone: "absent" };
  }
}

/**
 * The rows a tab shows, in list() order: All is every copy with a name's copies side by side, or only the
 * winners with `hideOverridden`; a catalog tab is that catalog's copies; the disabled tab is the winners
 * switched off. "overrides" shows only on a winning copy outside a catalog tab.
 */
export function rowsFor(tab: Tab, records: EntryRecord[], hideOverridden: boolean): Row[] {
  const winners = records.filter((e) => e.overriddenBy === null);
  let shown: EntryRecord[];
  if (tab.kind === "disabled") shown = winners.filter((e) => e.disabled);
  else if (tab.kind === "catalog") shown = records.filter((e) => e.catalog === tab.id);
  else if (hideOverridden) shown = winners;
  else shown = groupByName(records);
  return shown.map((entry) => ({
    entry,
    ...installStatus(entry),
    overrides: tab.kind === "catalog" || entry.overriddenBy !== null ? [] : entry.overrides,
  }));
}

/**
 * The rows matching `query`, name prefix first, then anywhere in the name, then description only: a term
 * is nearly always a name being hunted, and descriptions mention other names freely. Stable, so a name's
 * copies stay together.
 */
export function searchRows(rows: Row[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const rank = (row: Row) => {
    const name = row.entry.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return row.entry.description.toLowerCase().includes(q) ? 2 : 3;
  };
  return rows
    .map((row) => ({ row, rank: rank(row) }))
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map(({ row }) => row);
}

/** What writing to a catalog costs, in words. */
export function writeModeText(catalog: CatalogRow): string {
  if (!catalog.writable) return "read-only";
  return catalog.writeMode === "pr" ? "writes via pull request" : "writes directly";
}

type Value<T> = T extends (...args: never[]) => Promise<infer R> ? (R extends { ok: true; value: infer V } ? V : never) : never;
export type PushResult = Value<Library["applyPush"]>;

/** How a finished push ended, in words that match what happened, and the link worth offering. */
export interface PushOutcome {
  headline: string;
  detail: string | null;
  link: { url: string; label: string } | null;
}

/**
 * What a push really did. A remote push always pushes its branch and only sometimes opens the PR, so this
 * says "opened" only when the host's API opened one: a branch with a compare link is not in anyone's queue.
 */
export function describePush(result: PushResult): PushOutcome {
  if (!result.changed) {
    return { headline: "Nothing to push.", detail: `The local copy of ${result.name} already matches its source.`, link: null };
  }
  if (result.kind === "local") {
    return {
      headline: `Copied ${result.name} back to its source.`,
      detail: `${result.target} — a local source is written straight through, with no pull request.`,
      link: null,
    };
  }
  const pr = result.pr;
  if (pr?.method === "api" && pr.prUrl) {
    return { headline: "Pull request opened.", detail: `From ${pr.branch}.`, link: { url: pr.prUrl, label: "View the pull request" } };
  }
  return {
    headline: "Branch pushed — the pull request is not open yet.",
    detail: pr
      ? `${pr.branch} is on the remote. Opening the pull request is the next step, and nobody has been asked to review anything until you do.`
      : "Opening the pull request is the next step.",
    link: pr?.compareUrl ? { url: pr.compareUrl, label: "Open a pull request" } : null,
  };
}

export type { PlanItem };

/** What sits at a destination before an install, in words. */
export function describeDestState(state: PlanItem["state"]): string {
  switch (state) {
    case "installed":
      return "already installed";
    case "drifted":
      return "edited locally";
    case "unmanaged":
      return "installed outside Loadout";
    case "absent":
      return "new";
  }
}

/** One line for what an install changed, as the CLI words it. */
export function summarizeChanges(preview: PlanItem["preview"]): string {
  if (preview.kind === "destination-only") return "installed";
  if (preview.newInstall) return "new install";
  const parts = (
    [
      [preview.modified.length, "modified"],
      [preview.added.length, "added"],
      [preview.removed.length, "removed"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return parts.length ? parts.join(", ") : "no changes";
}

/**
 * The install button, described by the plan rather than by "is it installed somewhere", and a caution
 * per state rather than one blanket warning: a clean copy has no edits to lose, so saying it does would
 * train people to click through. Drift has its own acknowledgement.
 */
export function describeInstallAction(items: PlanItem[]): { label: string; caution: string | null } {
  const present = items.filter((i) => i.state !== "absent");
  if (!present.length) return { label: "Install", caution: null };
  const everything = present.length === items.length;
  const label = everything ? "Reinstall" : "Install";
  if (everything && present.every((i) => i.state === "installed")) {
    return { label, caution: "Every copy already matches its source, so this only changes anything if the source has moved on since." };
  }
  return { label, caution: null };
}

/** What a catalog is and what writing to it costs, in words rather than field values. */
export function describeCatalog(catalog: CatalogRow): { what: string; note: string } {
  const what = catalog.kind === "local" ? "a file on this machine" : "a shared git repository";
  if (catalog.skipped) return { what, note: `Not loaded — ${catalog.skipped}` };
  if (!catalog.writable) return { what, note: "Registered as read-only, so nothing can be written to it." };
  if (catalog.kind !== "local") {
    const how =
      catalog.writeMode === "pr"
        ? "opens a pull request there, so it gets the same review as any other change"
        : "is committed and pushed to that repository";
    return { what, note: `Entries here are changed in the repository itself, where the change ${how}.` };
  }
  return { what, note: "Edits are saved straight to the file." };
}

/** "1st", "2nd", "3rd", "11th"… */
export function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const mod100 = n % 100;
  return `${n}${suffixes[(mod100 - 20) % 10] ?? suffixes[mod100] ?? suffixes[0]}`;
}
