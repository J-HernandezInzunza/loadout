// One entry point for every catalog write: the catalog's write mode decides how the edit lands
// (behaviors.md §1.2 derived write mode): a local catalog in place, an unprotected remote straight
// into its clone and pushed, a protected remote through a pull request.
import type { Accounts } from "../accounts/accounts.ts";
import type { ApiBases } from "../accounts/apiBases.ts";
import type { ConfigStore } from "../config/config.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import type { Host } from "../host.ts";
import type { Result } from "../model/model.ts";
import type { CatalogState } from "../registry/registry.ts";
import { applyDirectWrite, planDirectWrite, type DirectPlan } from "./direct.ts";
import type { CatalogEdit, EditPlan, WriteResult } from "./edit.ts";
import { applyLocalWrite, planLocalWrite } from "./local.ts";
import { applyPrWrite, planPrWrite, type PrPlan } from "./pr.ts";

export interface WriteCtx {
  host: Host;
  git: GitClient;
  config: ConfigStore;
  accounts?: Pick<Accounts, "tokenFor">;
  apiBases?: ApiBases;
}

export type WriteMode = "local" | "direct" | "pr";

export type ModePlan =
  | { mode: "local"; catalog: CatalogState; plan: EditPlan }
  | { mode: "direct"; catalog: CatalogState; plan: DirectPlan }
  | { mode: "pr"; catalog: CatalogState; plan: PrPlan };

export function writeMode(catalog: CatalogState): WriteMode {
  const ref = catalog.ref;
  return ref.kind === "local" ? "local" : ref.protected ? "pr" : "direct";
}

export async function planWrite(ctx: WriteCtx, catalog: CatalogState, edit: CatalogEdit, opts: CallOpts & { dryRun?: boolean } = {}): Promise<Result<ModePlan>> {
  const mode = writeMode(catalog);
  if (mode === "local") {
    const p = await planLocalWrite(ctx.host, catalog, edit, opts);
    return p.ok ? { ...p, value: { mode, catalog, plan: p.value } } : p;
  }
  if (mode === "direct") {
    const p = await planDirectWrite(ctx, catalog, edit, opts);
    return p.ok ? { ...p, value: { mode, catalog, plan: p.value } } : p;
  }
  const p = await planPrWrite(ctx, catalog, edit, opts);
  return p.ok ? { ...p, value: { mode, catalog, plan: p.value } } : p;
}

export function applyWrite(ctx: WriteCtx, planned: ModePlan, opts: CallOpts = {}): Promise<Result<WriteResult>> {
  if (planned.mode === "local") return applyLocalWrite(ctx.host, planned.catalog, planned.plan);
  if (planned.mode === "direct") return applyDirectWrite(ctx, planned.catalog, planned.plan, opts);
  return applyPrWrite(ctx, planned.catalog, planned.plan, opts);
}

/** A plan that won't be applied: only PR mode holds anything (its temp clone). */
export async function discardWrite(planned: ModePlan): Promise<void> {
  if (planned.mode === "pr") await planned.plan.op.dispose();
}
