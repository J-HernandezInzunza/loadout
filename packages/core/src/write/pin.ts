// Pinning a name to one catalog (behaviors.md §3.6, §3.7; RES-13..17). A pin outranks catalog
// precedence for that name alone. Planning refuses what can't be pinned and assesses what the pin
// means for the copy already installed (RES-15), before anything is written; applying writes the pin
// and, when asked and nothing needs a decision, installs the pinned copy over the old one. Unpinning
// hands the name back to precedence and leaves installed copies alone. Global installs only (R9), so
// the CLI's project-scope and parked-copy cases are moot (A24).
import type { CallOpts } from "../git/git.ts";
import { applyInstall, type ApplyReport } from "../install/apply.ts";
import { catalogKeys, planInstall, type InstallCtx } from "../install/plan.ts";
import { dependents as dependentsOf, resolveDeps } from "../deps/deps.ts";
import { err, ok, type Entry, type Result } from "../model/model.ts";
import { loadRegistry, type Registry } from "../registry/registry.ts";
import { destFor, destState } from "../scan/scan.ts";

export interface StaleCopy {
  dest: string;
  state: "installed" | "drifted" | "unmanaged";
  /** the catalog the receipt records; null for a copy Loadout didn't install */
  from: string | null;
}

/** RES-15: what pointing the name at the catalog means for what is installed. */
export interface SwitchAssessment {
  /** a copy from elsewhere is installed */
  switchable: boolean;
  /** switchable and nothing needs a decision: installing the pinned copy is safe unattended */
  simple: boolean;
  stale: StaleCopy[];
  /** why installing over the copy needs the user's decision, as sentences */
  blockers: string[];
  /** refs of the pinned copy that don't resolve in its catalog */
  unresolvedRequires: { ref: string; requiredBy: string }[];
  /** names the pinned copy's closure would newly install */
  newDependencies: string[];
  /** installed entries of the old catalog that require the name, directly or not */
  dependents: { name: string; catalog: string; direct: boolean }[];
}

export interface PinPlan {
  name: string;
  catalog: string;
  /** the catalog the name was pinned to before; null when it wasn't */
  previous: string | null;
  /** catalogs defining the name, in precedence order */
  holders: string[];
  /** RES-14: the pin is kept but inert until another catalog defines the name */
  onlyHolder: boolean;
  switch: SwitchAssessment;
}

export interface PinResult extends PinPlan {
  /** RES-16: the install that switched the copy over; null when nothing was installed */
  installed: ApplyReport | null;
}

export async function assessSwitch(ctx: InstallCtx, registry: Registry, name: string, catalog: string): Promise<SwitchAssessment> {
  const { host } = ctx;
  const pinned = registry.entriesOf(catalog).find((e) => e.name === name);
  const empty: SwitchAssessment = { switchable: false, simple: false, stale: [], blockers: [], unresolvedRequires: [], newDependencies: [], dependents: [] };
  if (!pinned) return empty;

  const keys = await catalogKeys(host, registry);
  const idOfKey = new Map([...keys].map(([id, key]) => [key, id]));
  const receiptFor = async (dest: string) => {
    const r = await ctx.receipts.get(dest);
    return r.ok ? r.value : null;
  };
  const installed = async (e: Entry) => (await host.fs.lstat(destFor(host.paths.home, e.type, e.name)).catch(() => null)) !== null;

  const stale: StaleCopy[] = [];
  const dest = destFor(host.paths.home, pinned.type, pinned.name);
  const receipt = await receiptFor(dest);
  const state = await destState(host, dest, receipt);
  if (state.state !== "absent" && !(receipt !== null && receipt.catalog.key === keys.get(catalog))) {
    stale.push({ dest, state: state.state, from: receipt?.catalog.id ?? null });
  }

  const { order, unresolved } = resolveDeps(registry.entriesOf(catalog), pinned);
  const newDependencies: string[] = [];
  for (const d of order) if (!(d.type === pinned.type && d.name === pinned.name) && !(await installed(d))) newDependencies.push(d.name);

  const dependents: SwitchAssessment["dependents"] = [];
  // The old catalog by identity: the receipt's id may name a catalog since renamed.
  const oldId = receipt !== null && stale.length > 0 ? idOfKey.get(receipt.catalog.key) : undefined;
  const old = oldId === undefined ? undefined : registry.entriesOf(oldId).find((e) => e.type === pinned.type && e.name === name);
  if (old) {
    for (const { entry, direct } of dependentsOf(registry.entriesOf(oldId!), old)) {
      if (await installed(entry)) dependents.push({ name: entry.name, catalog: oldId!, direct });
    }
  }

  const blockers: string[] = [];
  for (const copy of stale) {
    if (copy.state === "drifted") blockers.push(`the copy at ${copy.dest} has edits Loadout didn't make; installing over it discards them`);
    else if (copy.state === "unmanaged") blockers.push(`the copy at ${copy.dest} wasn't installed by Loadout, so there is no record of what it is`);
  }
  for (const u of unresolved) blockers.push(`the '${catalog}' copy requires ${u.ref}, which doesn't resolve in '${catalog}'`);

  return {
    switchable: stale.length > 0,
    simple: stale.length > 0 && blockers.length === 0,
    stale,
    blockers,
    unresolvedRequires: unresolved.map((u) => ({ ref: u.ref, requiredBy: u.requiredBy })),
    newDependencies,
    dependents,
  };
}

/** RES-13 refusals, then the assessment; nothing is written. */
export async function planPin(ctx: InstallCtx, req: { name: string; catalog: string }): Promise<Result<PinPlan>> {
  const { name, catalog } = req;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const active = registry.active().map((c) => c.ref.id);
  if (catalog === "") return err({ code: "REFUSED", message: `which catalog should '${name}' resolve from?` });
  if (!active.includes(catalog)) return err({ code: "UNKNOWN_CATALOG", message: `unknown catalog '${catalog}' (available: ${active.join(", ") || "none"})` });
  const holders = active.filter((id) => registry.entriesOf(id).some((e) => e.name === name));
  if (holders.length === 0) return err({ code: "NOT_FOUND", message: `no catalog defines '${name}'; nothing to pin` });
  // A pin to a catalog without the name would be inert; writing it would look like a choice was made.
  if (!holders.includes(catalog)) return err({ code: "NOT_FOUND", message: `'${catalog}' does not define '${name}' (defined in: ${holders.join(", ")})` });

  return ok({
    name,
    catalog,
    previous: loaded.value.config.pins[name] ?? null,
    holders,
    onlyHolder: holders.length === 1,
    switch: await assessSwitch(ctx, registry, name, catalog),
  });
}

/**
 * Writes the pin and re-assesses against the registry it now makes. With `switchInstalled`, a simple
 * switch installs the pinned copy (RES-16) and the result is assessed again after it; with blockers
 * nothing is installed and the pin still stands.
 */
export async function applyPin(ctx: InstallCtx, plan: PinPlan, opts: CallOpts & { switchInstalled: boolean }): Promise<Result<PinResult>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  if ((loaded.value.config.pins[plan.name] ?? null) !== plan.previous) {
    return err({ code: "STALE_PLAN", message: `the pin for '${plan.name}' changed since this was planned; plan it again` });
  }
  const saved = await ctx.config.updateConfig((c) => ({ ...c, pins: { ...c.pins, [plan.name]: plan.catalog } }));
  if (!saved.ok) return saved;
  const registry = await loadRegistry(ctx.host, saved.value);
  const assessed = await assessSwitch(ctx, registry, plan.name, plan.catalog);
  const result: PinResult = { ...plan, switch: assessed, installed: null };
  if (!opts.switchInstalled || !assessed.simple) return ok(result);

  const install = await planInstall(ctx, { names: [plan.name] }, opts);
  if (!install.ok) return ok(result, [{ message: `pinned, but the '${plan.catalog}' copy couldn't be installed: ${install.error.message}` }]);
  const applied = await applyInstall(ctx, install.value, opts.signal ? { signal: opts.signal } : {});
  if (!applied.ok) return ok(result, [...install.warnings, { message: `pinned, but the '${plan.catalog}' copy couldn't be installed: ${applied.error.message}` }]);
  const after = await assessSwitch(ctx, registry, plan.name, plan.catalog);
  return ok({ ...result, switch: after, installed: applied.value }, [...install.warnings, ...applied.warnings]);
}

/** RES-17: drops the pin; installed copies are untouched. */
export async function unpin(ctx: Pick<InstallCtx, "host" | "config">, name: string): Promise<Result<{ name: string; was: string; resolvesTo: string | null }>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const pins = loaded.value.config.pins;
  const was = pins[name];
  if (was === undefined) {
    return err({ code: "NOT_FOUND", message: `'${name}' is not pinned (pinned: ${Object.keys(pins).sort().join(", ") || "none"})` });
  }
  const saved = await ctx.config.updateConfig((c) => ({ ...c, pins: Object.fromEntries(Object.entries(c.pins).filter(([n]) => n !== name)) }));
  if (!saved.ok) return saved;
  const resolved = (await loadRegistry(ctx.host, saved.value)).resolve(name);
  return ok({ name, was, resolvesTo: resolved.ok ? resolved.value.catalog : null });
}
