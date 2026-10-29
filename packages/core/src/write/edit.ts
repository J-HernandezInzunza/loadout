// The catalog edit every write mode shares (WRITE-15..18, LOCK-03 fixed by A32). The edit is always
// computed from the exact text being replaced, so a stale registry copy can't clobber an upstream
// change; the result is re-parsed and checked before anything is written; and the write is atomic
// and refused if the file changed since it was planned.
import { catalogEntries, parseCatalog, verifyEdit } from "../catalog/read.ts";
import { removeEntry, replaceEntry, spliceEntry } from "../catalog/splice.ts";
import type { Host } from "../host.ts";
import { LibraryError, err, ok, type Entry, type EntryType, type Result } from "../model/model.ts";
import { unifiedDiff } from "./diff.ts";

type NewEntry = Omit<Entry, "catalog">;
export type EntryFields = Partial<Pick<Entry, "description" | "source" | "requires">>;

export type CatalogEdit =
  /** EDIT-13: a batch lands as one write, inserted in order */
  | { op: "add"; entries: NewEntry[] }
  /** name and type are fixed; only the given fields change; the requires deltas apply to the requires the text holds */
  | { op: "update"; type: EntryType; name: string; fields: EntryFields; addRequires?: string[]; removeRequires?: string[] }
  | { op: "remove"; type: EntryType; name: string };

const sameFields = (a: EntryFields, b: EntryFields) =>
  a.description === b.description && a.source === b.source && JSON.stringify(a.requires ?? []) === JSON.stringify(b.requires ?? []);

/** WRITE-15, WRITE-16: the new text for `edit` applied to `text`, verified; `changed` is false for a field-level no-op. */
export function computeEdit(text: string, edit: CatalogEdit): Result<{ text: string; changed: boolean }> {
  try {
    if (edit.op === "add") {
      let next = text;
      for (const entry of edit.entries) next = spliceEntry(next, entry);
      for (const entry of edit.entries) verifyEdit(next, entry, true);
      return ok({ text: next, changed: true });
    }
    // The entry as this very text has it, not as a registry loaded earlier saw it.
    const parsed = parseCatalog(text);
    const current = parsed.ok ? catalogEntries(parsed.data, "").entries.find((e) => e.type === edit.type && e.name === edit.name) : undefined;
    if (!current) {
      const message = edit.op === "update" ? `'${edit.name}' was removed from the catalog upstream; nothing to update` : `${edit.type} '${edit.name}' is not in the catalog`;
      return err({ code: "NOT_FOUND", message });
    }
    if (edit.op === "remove") {
      const next = removeEntry(text, edit.type, edit.name);
      verifyEdit(next, edit, false);
      return ok({ text: next, changed: true });
    }
    const merged: NewEntry = {
      type: current.type,
      name: current.name,
      description: edit.fields.description ?? current.description,
      source: edit.fields.source ?? current.source,
      requires: [
        ...(edit.fields.requires ?? current.requires).filter((r) => !(edit.removeRequires ?? []).includes(r)),
        ...(edit.addRequires ?? []).filter((r) => !(edit.fields.requires ?? current.requires).includes(r)),
      ],
    };
    if (sameFields(merged, current)) return ok({ text, changed: false });
    const next = replaceEntry(text, edit.type, edit.name, merged);
    verifyEdit(next, merged, true);
    return ok({ text: next, changed: true });
  } catch (e) {
    if (e instanceof LibraryError) return err({ code: e.code, message: e.line === undefined ? e.message : `${e.message} (line ${e.line})` });
    throw e;
  }
}

export interface EditPlan {
  /** the catalog file the edit replaces */
  file: string;
  /** shown in diffs: the yaml path for a clone, the basename for a local file (WRITE-17) */
  displayName: string;
  before: string;
  after: string;
  changed: boolean;
  /** sha256 of `before`; apply refuses a file that no longer has these bytes */
  fingerprint: string;
  /** WRITE-17: present for a dry run */
  diff?: string;
}

export async function planCatalogEdit(
  host: Host,
  target: { file: string; displayName: string },
  edit: CatalogEdit,
  opts: { dryRun?: boolean } = {},
): Promise<Result<EditPlan>> {
  if (!(await host.fs.exists(target.file))) return err({ code: "NOT_FOUND", message: `catalog file not found: ${target.file}` });
  const before = await host.fs.readText(target.file);
  const computed = computeEdit(before, edit);
  if (!computed.ok) return computed;
  const { text: after, changed } = computed.value;
  return ok({
    ...target,
    before,
    after,
    changed,
    fingerprint: await host.sha256(new TextEncoder().encode(before)),
    ...(opts.dryRun && { diff: unifiedDiff(target.displayName, before, after) }),
  });
}

/** Writes a planned edit in place, atomically (A32); STALE_PLAN when the file changed after planning. */
export async function applyCatalogEdit(host: Host, plan: EditPlan): Promise<Result<{ path: string; changed: boolean }>> {
  const now = (await host.fs.exists(plan.file)) ? await host.fs.readText(plan.file) : null;
  if (now === null || (await host.sha256(new TextEncoder().encode(now))) !== plan.fingerprint) {
    return err({ code: "STALE_PLAN", message: `${plan.file} changed since the edit was planned; plan it again` });
  }
  if (plan.changed) {
    await host.fs.writeTextAtomic(plan.file, plan.after);
    host.audit({ kind: "fs", op: "write", path: plan.file });
  }
  return ok({ path: plan.file, changed: plan.changed });
}

/** WRITE-18: what every write reports; the keys present depend on the mode. */
export type WriteResult =
  | { mode: "local" | "direct"; catalog: string; changed: boolean; path: string; committed: boolean; pushed: boolean; branch: string | null; diff?: string }
  /** branch is null when the edit was a no-op and nothing was committed */
  | { mode: "pr"; catalog: string; changed: boolean; method: "api" | "manual"; branch: string | null; prUrl?: string; compareUrl?: string | null; diff?: string };

/** WRITE-18 for the in-place modes: the file's path, whether git committed and pushed it, and the diff of a dry run. */
export function inPlaceResult(
  mode: "local" | "direct",
  catalog: string,
  plan: EditPlan,
  git: { committed: boolean; pushed: boolean; branch: string | null },
): WriteResult {
  return { mode, catalog, changed: plan.changed, path: plan.file, ...git, ...(plan.diff !== undefined && { diff: plan.diff }) };
}
