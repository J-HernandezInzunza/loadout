// Adding entries to a catalog (behaviors.md §3.12): every entry is checked before the catalog is
// touched, in the CLI's order, and a batch lands as one write (EDIT-13). Overriding another catalog's
// entry and requiring something not in the catalog yet are warnings, not refusals.
import { validateRef } from "../catalog/splice.ts";
import type { CallOpts } from "../git/git.ts";
import { LibraryError, err, ok, type Entry, type EntryType, type Result, type Warning } from "../model/model.ts";
import { loadRegistry, type CatalogState, type Registry } from "../registry/registry.ts";
import { installDirs } from "../scan/scan.ts";
import { parseSource } from "../source/source.ts";
import type { WriteResult } from "./edit.ts";
import { suggestSource } from "./suggest.ts";
import { writeTarget, type WriteTargetErr } from "./target.ts";
import { applyWrite, planWrite, type ModePlan, type WriteCtx } from "./write.ts";

export interface NewEntryInput {
  name: string;
  description: string;
  source: string;
  /** inferred from the source when absent: skill.md → skill, agent.md → agent, else prompt */
  type?: EntryType;
  requires?: string[];
}

export interface AddRequest {
  entries: NewEntryInput[];
  catalog?: string;
  /** WRITE-05: let a local path into a remote catalog (a personal remote catalog, on purpose) */
  allowLocal?: boolean;
  dryRun?: boolean;
}

export interface AddPlan {
  write: ModePlan;
  added: { type: EntryType; name: string }[];
}

type NewEntry = Omit<Entry, "catalog">;
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));

/** The checks one entry must pass whatever else is in the batch. */
async function prepare(ctx: WriteCtx, input: NewEntryInput, dest: CatalogState, multi: boolean, allowLocal: boolean): Promise<Result<NewEntry>> {
  const { host } = ctx;
  if (!input.name || !input.description || !input.source) return err({ code: "REFUSED", message: "each entry needs a name, description, and source" });
  const lower = input.source.toLowerCase();
  const type: EntryType = input.type ?? (lower.includes("skill.md") ? "skill" : lower.includes("agent.md") ? "agent" : "prompt");

  let src;
  try {
    src = parseSource(input.source, host.paths.home);
  } catch (e) {
    if (e instanceof LibraryError) return err({ code: e.code, message: e.message });
    throw e;
  }

  if (src.kind === "local") {
    const kind = await host.fs.stat(src.path).then((s) => s.kind, () => null);
    if (kind === null) return err({ code: "SOURCE_MISSING", message: `local source not found: ${input.source}` });
    // A9: a folder source installs its parent folder, which is never what was meant.
    if (kind === "dir") {
      return err({ code: "INVALID_SOURCE", message: `${input.source} is a folder; point the source at the file itself (a skill's SKILL.md), since a folder source installs the folder above it` });
    }
    // Q13 d: a skill at a repo's root would copy the whole repository.
    if (type === "skill" && (await host.fs.exists(`${dirname(src.path)}/.git`))) {
      return err({ code: "INVALID_SOURCE", message: `${input.source} sits at the root of a git repository, so installing it would copy the whole repository; move the skill into its own folder` });
    }
    // WRITE-05: a path only resolves on this machine.
    if (dest.ref.kind === "remote" && !allowLocal) {
      const hint = (await suggestSource(host, ctx.git, src.path)).url;
      const why = multi
        ? `local-path sources don't resolve for anyone else pulling catalog '${dest.ref.id}'. Provide a GitHub/Bitbucket URL, allow local paths, or add it to a local catalog, which accepts paths.`
        : "local-path sources don't resolve for teammates pulling the shared catalog. Provide a GitHub/Bitbucket URL, or allow local paths for a personal catalog.";
      return err({ code: "LOCAL_SOURCE_REFUSED", message: hint ? `${why} This file is in a git repo — did you mean: ${hint}` : why });
    }
    // WRITE-06: an entry sourced from where it installs overwrites its own source.
    const dir = Object.entries(installDirs(host.paths.home)).find(([, d]) => src.path === d || src.path.startsWith(d + "/"));
    if (dir) {
      const hint = (await suggestSource(host, ctx.git, src.path)).url;
      return err({
        code: "SOURCE_IN_INSTALL_DIR",
        message:
          `${src.path} is inside ${dir[1]}, which is where ${dir[0]}s install: an entry sourced from there overwrites its own source the first time it is installed. ` +
          `Keep the content in a repository you own and point the source at it there.${hint ? ` This file is in a git repo — use its URL instead: ${hint}` : ""}`,
      });
    }
  } else if (type === "skill" && src.parentPath === "") {
    // Q13 d, for a remote source.
    return err({ code: "INVALID_SOURCE", message: `${input.source} sits at the root of ${src.org}/${src.repo}, so installing it would copy the whole repository; move the skill into its own folder` });
  }

  const requires = input.requires ?? [];
  try {
    requires.forEach(validateRef); // DEP-11
  } catch (e) {
    if (e instanceof LibraryError) return err({ code: e.code, message: e.message });
    throw e;
  }
  return ok({ type, name: input.name, description: input.description, source: input.source, requires: requires.map((r) => r.trim()) });
}

/** The CLI's new_entry_override_warnings: which copy of a shared name wins, and why. */
function overrideWarnings(registry: Registry, pins: Record<string, string>, dest: string, name: string): Warning[] {
  const order = registry.active().map((c) => c.ref.id);
  const rank = order.indexOf(dest);
  const pinned = pins[name] ?? "";
  const overrides: string[] = [];
  const overriddenBy: string[] = [];
  for (const other of registry.active()) {
    if (other.ref.id === dest || !other.entries.some((e) => e.name === name)) continue;
    if (pinned === dest) overrides.push(other.ref.id);
    else if (pinned === other.ref.id) overriddenBy.push(other.ref.id);
    else (order.indexOf(other.ref.id) > rank ? overrides : overriddenBy).push(other.ref.id);
  }
  const out: Warning[] = [];
  if (overrides.length > 0) {
    const why = pinned === dest ? "is pinned" : "takes precedence";
    out.push({ message: `'${name}' also exists in ${overrides.join(", ")}; the copy in '${dest}' ${why} and will override it` });
  }
  if (overriddenBy.length > 0) {
    out.push({
      message:
        pinned && pinned !== dest
          ? `'${name}' also exists in ${overriddenBy.join(", ")}; '${pinned}' is pinned for this name, so the copy in '${dest}' will be overridden`
          : `'${name}' also exists in ${overriddenBy.join(", ")}, which takes precedence; the copy in '${dest}' will be overridden`,
    });
  }
  return out;
}

export async function planAdd(ctx: WriteCtx, req: AddRequest, opts: CallOpts = {}): Promise<Result<AddPlan, WriteTargetErr>> {
  if (req.entries.length === 0) return err({ code: "REFUSED", message: "nothing to add" });
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const registry = await loadRegistry(ctx.host, loaded.value.config);
  const target = writeTarget(registry, { op: "add", ...(req.catalog !== undefined && { catalog: req.catalog }) });
  if (!target.ok) return target;
  const dest = target.value.catalog;
  const multi = registry.catalogs().length > 1;

  const entries: NewEntry[] = [];
  for (const input of req.entries) {
    const prepared = await prepare(ctx, input, dest, multi, req.allowLocal ?? false);
    if (!prepared.ok) return prepared;
    entries.push(prepared.value);
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.name)) return err({ code: "DUPLICATE", message: `duplicate entry '${e.name}' in batch` });
    seen.add(e.name);
  }
  const label = multi ? `catalog '${dest.ref.id}'` : "catalog";
  const warnings: Warning[] = [];
  for (const e of entries) {
    const existing = dest.entries.find((x) => x.name === e.name);
    if (existing) return err({ code: "DUPLICATE", message: `'${e.name}' already in ${label} (type ${existing.type}); install it to refresh, or update it to change it` });
    warnings.push(...overrideWarnings(registry, loaded.value.config.pins, dest.ref.id, e.name));
  }
  // DEP-10: known means in the destination catalog or elsewhere in this batch.
  const known = new Set([...dest.entries, ...entries].map((e) => `${e.type}:${e.name}`));
  for (const e of entries) {
    for (const r of e.requires) if (!known.has(r)) warnings.push({ message: `required dependency ${r} (for ${e.name}) is not in the catalog yet` });
  }

  const planned = await planWrite(ctx, dest, { op: "add", entries }, { ...opts, ...(req.dryRun && { dryRun: true }) });
  if (!planned.ok) return planned;
  return ok({ write: planned.value, added: entries.map((e) => ({ type: e.type, name: e.name })) }, [...warnings, ...planned.warnings]);
}

export async function applyAdd(ctx: WriteCtx, plan: AddPlan, opts: CallOpts = {}): Promise<Result<WriteResult & { added: AddPlan["added"] }>> {
  const res = await applyWrite(ctx, plan.write, opts);
  return res.ok ? { ...res, value: { ...res.value, added: plan.added } } : res;
}
