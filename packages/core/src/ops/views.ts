// Decisions the screens need that no single op answers, computed from op results (list, catalogs, pins,
// show, planInstall) so the UI words them without re-deriving them (behaviors.md §6 W-UI1).
import { parseRef } from "../deps/deps.ts";
import type { PlanItem } from "../install/plan.ts";
import type { EntryRecord } from "../registry/registry.ts";
import { splitOverrides } from "../write/add.ts";
import type { UpdateRequest } from "../write/update.ts";
import type { CatalogRow, PinRecord } from "./schemas.ts";

/**
 * Every copy, each name's copies moved up to its first copy's position: list() order otherwise, so an
 * overridden copy sits beside the copy it loses to rather than at the end with its catalog.
 */
export function groupByName(records: EntryRecord[]): EntryRecord[] {
  const groups = new Map<string, EntryRecord[]>();
  for (const r of records) groups.set(r.name, [...(groups.get(r.name) ?? []), r]);
  return [...groups.values()].flat();
}

/** The refs an entry of `catalog` may require: dependencies resolve within one catalog (DEP-02), never itself. */
export function requirableRefs(records: EntryRecord[], catalog: string, self?: string): string[] {
  return records
    .filter((r) => r.catalog === catalog)
    .map((r) => `${r.type}:${r.name}`)
    .filter((ref) => ref !== self)
    .sort();
}

export interface AddConsequences {
  /** `catalog` already holds the name, so the add is refused (DUPLICATE) */
  blocked: boolean;
  /** catalogs whose copy the new one would beat */
  overrides: string[];
  /** catalogs whose copy would beat the new one, so it would not be the one installed */
  overriddenBy: string[];
}

/** What adding `name` to `catalog` would do to the copies that exist, as planAdd decides it (case-sensitive). */
export function addConsequences(
  view: { records: EntryRecord[]; catalogs: CatalogRow[]; pins: PinRecord[] },
  name: string,
  catalog: string,
): AddConsequences {
  const holders = view.records.filter((r) => r.name === name).map((r) => r.catalog);
  const active = view.catalogs.filter((c) => c.skipped === null).map((c) => c.id);
  const pinned = view.pins.find((p) => p.name === name)?.catalog ?? "";
  return { blocked: holders.includes(catalog), ...splitOverrides(active, holders, pinned, catalog) };
}

export interface EntryDraft {
  description: string;
  source: string;
  requires: string[];
}

/**
 * The planUpdate fields that change `copy` into `draft`, or null when nothing would (planUpdate refuses an
 * empty update). Values are trimmed; requires compare as a set of refs, spacing around `:` ignored.
 */
export function entryEdits(copy: EntryDraft, draft: EntryDraft): Pick<UpdateRequest, "setDescription" | "setSource" | "setRequires"> | null {
  const description = draft.description.trim();
  const source = draft.source.trim();
  const requires = draft.requires.map(refKey).sort();
  const before = new Set(copy.requires.map(refKey));
  const sameRequires = before.size === new Set(requires).size && requires.every((r) => before.has(r));

  const edits = {
    ...(description !== copy.description && { setDescription: description }),
    ...(source !== copy.source && { setSource: source }),
    ...(!sameRequires && { setRequires: requires }),
  };
  return Object.keys(edits).length > 0 ? edits : null;
}

function refKey(ref: string): string {
  const parsed = parseRef(ref);
  return parsed ? `${parsed.type}:${parsed.name}` : ref.trim();
}

/** The drift gate: ready items whose apply would replace files the user edited after Loadout installed them. */
export function discardsEdits(plan: { items: PlanItem[] }): PlanItem[] {
  return plan.items.filter((i) => i.status === "ready" && i.state === "drifted");
}
