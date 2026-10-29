// Direct write mode (WRITE-13): an unprotected remote catalog is edited in its persistent clone, then
// committed and pushed to its branch. The file is written first, so a commit or push failure is a
// warning reported in the result, not an error. A push refused because upstream moved leaves the
// clone one commit ahead and diverged; doctor finds it and offers a re-clone (A4, spikes.md S4).
import { cloneDir, refreshCatalogs } from "../catalogs/catalogs.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import type { Host } from "../host.ts";
import { err, ok, type Result, type Warning } from "../model/model.ts";
import type { CatalogState } from "../registry/registry.ts";
import { editCopy } from "./copy.ts";
import { applyCatalogEdit, inPlaceResult, planCatalogEdit, type CatalogEdit, type EditPlan, type WriteResult } from "./edit.ts";

export interface DirectCtx {
  host: Host;
  git: GitClient;
}

export interface DirectPlan {
  edit: CatalogEdit;
  plan: EditPlan;
}

type RemoteState = CatalogState & { ref: Extract<CatalogState["ref"], { kind: "remote" }> };

function remote(catalog: CatalogState): catalog is RemoteState {
  return catalog.ref.kind === "remote";
}

/** Refreshes the clone, then plans the edit against the file as it is after the pull (WRITE-15). */
export async function planDirectWrite(ctx: DirectCtx, catalog: CatalogState, edit: CatalogEdit, opts: CallOpts & { dryRun?: boolean } = {}): Promise<Result<DirectPlan>> {
  if (!remote(catalog)) return err({ code: "REFUSED", message: `catalog '${catalog.ref.id}' is local; it is written in place` });
  const { ref } = catalog;
  const refreshed = await refreshCatalogs(ctx.host, ctx.git, [ref], opts);
  if (!refreshed.ok) return refreshed;
  if (refreshed.value[0]!.outcome === "skipped") return err({ code: "GIT_FAILED", message: refreshed.warnings.map((w) => w.message).join("; ") });
  const file = `${cloneDir(ctx.host, ref.id)}/${ref.yamlPath}`;
  const planned = await planCatalogEdit(ctx.host, { file, displayName: ref.yamlPath }, edit, opts.dryRun ? { dryRun: true } : {});
  if (!planned.ok) return planned;
  // A failed pull still plans against the cached copy, and says so (RCAT-04).
  return ok({ edit, plan: planned.value }, [...refreshed.warnings, ...planned.warnings]);
}

export async function applyDirectWrite(ctx: DirectCtx, catalog: CatalogState, planned: DirectPlan, opts: CallOpts = {}): Promise<Result<WriteResult>> {
  if (!remote(catalog)) return err({ code: "REFUSED", message: `catalog '${catalog.ref.id}' is local; it is written in place` });
  const { ref } = catalog;
  const { plan } = planned;
  const nothing = { committed: false, pushed: false, branch: ref.branch };
  if (plan.diff !== undefined) return ok(inPlaceResult("direct", ref.id, plan, nothing));

  const written = await applyCatalogEdit(ctx.host, plan);
  if (!written.ok) return written;
  if (!plan.changed) return ok(inPlaceResult("direct", ref.id, plan, nothing));

  const warnings: Warning[] = [];
  const clone = cloneDir(ctx.host, ref.id);
  const committed = await ctx.git.commit(clone, [ref.yamlPath], editCopy(planned.edit).commit);
  if (!committed.ok) {
    warnings.push({ message: `${ref.yamlPath} was written but not committed: ${committed.error.message}` });
    return ok(inPlaceResult("direct", ref.id, plan, nothing), warnings);
  }
  const pushed = await ctx.git.push(clone, `HEAD:${ref.branch}`, opts);
  if (!pushed.ok) warnings.push({ message: `committed locally but not pushed: ${pushed.error.message}` });
  return ok(inPlaceResult("direct", ref.id, plan, { committed: true, pushed: pushed.ok, branch: ref.branch }), warnings);
}
