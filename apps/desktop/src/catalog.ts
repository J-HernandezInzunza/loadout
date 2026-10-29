// Wording, ranking and colour for the catalog list; what the rows are (winners, provenance, install state)
// is decided in the core and read off its records.
import { groupByName, type CatalogRow, type EntryRecord } from "@loadout/core";

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
