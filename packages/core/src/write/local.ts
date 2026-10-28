// Local write mode (WRITE-14 rebuild, Q11): a local catalog's file is written in place, atomically,
// and git is never run, so `git_commit` and its pull/commit/push are gone.
import type { Host } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";
import type { CatalogState } from "../registry/registry.ts";
import { applyCatalogEdit, inPlaceResult, planCatalogEdit, type CatalogEdit, type EditPlan, type WriteResult } from "./edit.ts";

export async function planLocalWrite(host: Host, catalog: CatalogState, edit: CatalogEdit, opts: { dryRun?: boolean } = {}): Promise<Result<EditPlan>> {
  if (catalog.ref.kind !== "local") return err({ code: "REFUSED", message: `catalog '${catalog.ref.id}' is remote; it is written through git, not in place` });
  const displayName = catalog.file.slice(catalog.file.lastIndexOf("/") + 1);
  return planCatalogEdit(host, { file: catalog.file, displayName }, edit, opts);
}

/** A dry run's plan reports its diff and writes nothing. */
export async function applyLocalWrite(host: Host, catalog: CatalogState, plan: EditPlan): Promise<Result<WriteResult>> {
  const git = { committed: false, pushed: false, branch: null };
  if (plan.diff !== undefined) return ok(inPlaceResult("local", catalog.ref.id, plan, git));
  const applied = await applyCatalogEdit(host, plan);
  return applied.ok ? ok(inPlaceResult("local", catalog.ref.id, plan, git)) : applied;
}
