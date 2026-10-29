// Updating an entry (behaviors.md §3.15). Name and type are fixed. The edit, the requires deltas
// included, is computed from the catalog text being written (WRITE-15), and lands through
// replaceEntry (EDIT-12 rebuild, D4): fields edited in place, unknown keys and comments kept. Equal
// fields are a no-op with no write.
import { catalogEntries, parseCatalog } from "../catalog/read.ts";
import type { CallOpts } from "../git/git.ts";
import { err, ok, type EntryType, type Result, type Warning } from "../model/model.ts";
import { loadRegistry } from "../registry/registry.ts";
import { checkRefs, checkSource } from "./add.ts";
import type { EditPlan, EntryFields, WriteResult } from "./edit.ts";
import { writeTarget, type WriteTargetErr } from "./target.ts";
import { applyWrite, planWrite, type ModePlan, type WriteCtx } from "./write.ts";

export interface UpdateRequest {
  name: string;
  catalog?: string;
  type?: EntryType;
  /** an empty string means "not given", as in the CLI */
  setDescription?: string;
  setSource?: string;
  /** replaces the list; [] clears it; excludes addRequires/removeRequires */
  setRequires?: string[];
  addRequires?: string[];
  removeRequires?: string[];
  allowLocal?: boolean;
  dryRun?: boolean;
}

export interface UpdatePlan {
  write: ModePlan;
  name: string;
}

const editPlanOf = (w: ModePlan): EditPlan => (w.mode === "local" ? w.plan : w.plan.plan);

export async function planUpdate(ctx: WriteCtx, req: UpdateRequest, opts: CallOpts = {}): Promise<Result<UpdatePlan, WriteTargetErr>> {
  const description = req.setDescription || undefined;
  const source = req.setSource || undefined;
  const adds = req.addRequires ?? [];
  const removes = req.removeRequires ?? [];
  if (description === undefined && source === undefined && req.setRequires === undefined && adds.length + removes.length === 0) {
    return err({ code: "REFUSED", message: "nothing to update: give a new description, source or requires" });
  }
  if (req.setRequires !== undefined && adds.length + removes.length > 0) {
    return err({ code: "REFUSED", message: "set the requires list, or add and remove refs, not both" });
  }

  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const target = writeTarget(registry, { op: "update", name: req.name, ...(req.type && { type: req.type }), ...(req.catalog !== undefined && { catalog: req.catalog }) });
  if (!target.ok) return target;
  const { catalog: dest, entry } = target.value;
  const type = entry!.type;

  if (source !== undefined) {
    // §3.15: unlike add, a local path that doesn't exist yet isn't refused.
    const checked = await checkSource(ctx, source, type, dest, { multi: registry.catalogs().length > 1, allowLocal: req.allowLocal ?? false, mustExist: false });
    if (!checked.ok) return checked;
  }
  const refs = checkRefs([...(req.setRequires ?? []), ...adds, ...removes]);
  if (!refs.ok) return refs;

  const fields: EntryFields = {
    ...(description !== undefined && { description }),
    ...(source !== undefined && { source }),
    ...(req.setRequires !== undefined && { requires: req.setRequires.map((r) => r.trim()) }),
  };
  const planned = await planWrite(
    ctx,
    dest,
    { op: "update", type, name: req.name, fields, ...(adds.length > 0 && { addRequires: adds.map((r) => r.trim()) }), ...(removes.length > 0 && { removeRequires: removes.map((r) => r.trim()) }) },
    { ...opts, ...(req.dryRun && { dryRun: true }) },
  );
  if (!planned.ok) return planned;

  // Warnings against the text being written, not the registry loaded before it.
  const warnings: Warning[] = [...planned.warnings];
  const edit = editPlanOf(planned.value);
  const parse = (text: string) => {
    const parsed = parseCatalog(text);
    return parsed.ok ? catalogEntries(parsed.data, dest.ref.id).entries : [];
  };
  const before = parse(edit.before).find((e) => e.type === type && e.name === req.name);
  for (const r of adds) if (before?.requires.includes(r.trim())) warnings.push({ message: `'${req.name}' already requires ${r.trim()}` });
  for (const r of removes) if (before && !before.requires.includes(r.trim())) warnings.push({ message: `'${req.name}' doesn't require ${r.trim()}` });
  const after = parse(edit.after);
  const known = new Set(after.map((e) => `${e.type}:${e.name}`));
  const updated = after.find((e) => e.type === type && e.name === req.name);
  // DEP-10: only the refs this update brings in.
  for (const r of updated?.requires ?? []) {
    if (!before?.requires.includes(r) && !known.has(r)) warnings.push({ message: `required dependency ${r} is not in the catalog yet` });
  }
  return ok({ write: planned.value, name: req.name }, warnings);
}

export async function applyUpdate(ctx: WriteCtx, plan: UpdatePlan, opts: CallOpts = {}): Promise<Result<WriteResult & { name: string }>> {
  const res = await applyWrite(ctx, plan.write, opts);
  return res.ok ? { ...res, value: { ...res.value, name: plan.name } } : res;
}
