// Registering, creating and unregistering catalogs (behaviors.md §3.19–3.21). Adding proves the
// catalog works before it is saved: a local file must parse as a catalog, a remote one is cloned (or
// its existing clone reused after the origin check, A20) and read. A remote's `protected` is always
// stored explicitly (A21). Removing purges installs from global destinations only (A19).
import { catalogEntries, parseCatalog } from "../catalog/read.ts";
import { scaffoldCatalog } from "../catalog/scaffold.ts";
import type { ClaudeSettings } from "../claudeSettings/settings.ts";
import type { ConfigStore } from "../config/config.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import type { Host } from "../host.ts";
import { err, ok, type CatalogRef, type Result, type Warning } from "../model/model.ts";
import type { ReceiptStore } from "../receipts/receipts.ts";
import { installDirs } from "../scan/scan.ts";
import { expandHome } from "../source/source.ts";
import { cloneDir, refreshCatalogs } from "./catalogs.ts";

export interface RegisterCtx {
  host: Host;
  git: GitClient;
  config: ConfigStore;
}

export type AddCatalogRequest = (
  | { kind: "local"; id: string; path: string }
  | { kind: "remote"; id: string; repo: string; protected: boolean; branch?: string; yamlPath?: string }
) & { writable?: boolean; position?: "first" | "last" };

export interface AddCatalogPlan {
  ref: CatalogRef;
  position: "first" | "last";
  /** the catalog file read to prove it works */
  file: string;
  entries: number;
}

const refuse = (id: string, problem: string) => err({ code: "REFUSED" as const, message: `cannot register catalog '${id}': ${problem}` });
const unusable = (id: string, problem: string) => err({ code: "REFUSED" as const, message: `'${id}' is not a usable catalog: ${problem}` });

/** A local catalog's file: a directory means its library.yaml (behaviors.md §1.2). */
async function localFile(host: Host, path: string): Promise<string> {
  const p = expandHome(path, host.paths.home);
  return (await host.fs.stat(p).then((s) => s.kind, () => null)) === "dir" ? `${p}/library.yaml` : p;
}

/** Reads `file` as a catalog: it must parse and have a `library:` mapping; field problems are only warnings. */
async function readUsable(host: Host, id: string, file: string): Promise<Result<number>> {
  if (!(await host.fs.exists(file))) return unusable(id, `no catalog file at ${file}`);
  const parsed = parseCatalog(await host.fs.readText(file));
  if (!parsed.ok) return unusable(id, `${file} doesn't parse: ${parsed.problem.message}`);
  const data = parsed.data as { library?: unknown } | null;
  if (typeof data !== "object" || data === null || !("library" in data)) return unusable(id, `${file} has no 'library:' mapping`);
  const { entries, problems } = catalogEntries(data, id);
  const broken = problems.find((p) => p.kind === "structure" && (p.path === "" || p.path === "library"));
  if (broken) return unusable(id, broken.message);
  return ok(entries.length, problems.map((p) => ({ message: `catalog '${id}': ${p.message}` })));
}

export async function planAddCatalog(ctx: RegisterCtx, req: AddCatalogRequest, opts: CallOpts = {}): Promise<Result<AddCatalogPlan>> {
  const { host } = ctx;
  const id = req.id.trim();
  if (id === "") return err({ code: "REFUSED", message: "a catalog needs a non-empty id" });
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const ids = loaded.value.config.catalogs.map((c) => c.id);
  if (ids.includes(id)) return err({ code: "DUPLICATE", message: `catalog '${id}' is already registered (ids: ${ids.join(", ")})` });
  const position = req.position ?? "first";
  const writable = req.writable === false ? { writable: false } : {};

  if (req.kind === "local") {
    if (!req.path.startsWith("/") && !req.path.startsWith("~")) return refuse(id, `path '${req.path}' must be absolute or start with '~'`);
    const file = await localFile(host, req.path);
    const read = await readUsable(host, id, file);
    if (!read.ok) return read;
    return ok({ ref: { id, kind: "local", path: req.path, ...writable }, position, file, entries: read.value }, read.warnings);
  }

  const yamlPath = req.yamlPath ?? "library.yaml";
  const branch = req.branch ?? "main";
  if (req.repo.trim() === "") return refuse(id, "the repo URL is empty");
  if (yamlPath.startsWith("/") || yamlPath.split("/").includes("..") || yamlPath.includes(":")) {
    return refuse(id, `yaml path '${yamlPath}' must be relative, without '..' or ':'`);
  }
  const ref: CatalogRef = { id, kind: "remote", repo: req.repo, yamlPath, branch, protected: req.protected, ...writable };
  const clone = cloneDir(host, id);
  const fresh = !(await host.fs.exists(clone));
  // Clones what is absent; reuses a clone of the same repo (pulling, or keeping it when the pull fails); refuses another repo's (A20).
  const refreshed = await refreshCatalogs(host, ctx.git, [ref], opts);
  if (!refreshed.ok) return refreshed;
  if (refreshed.value[0]!.outcome === "skipped") {
    return err({ code: "GIT_FAILED", message: refreshed.warnings.map((w) => w.message).join("; ") });
  }
  const file = `${clone}/${yamlPath}`;
  const read = await readUsable(host, id, file);
  if (!read.ok) {
    if (fresh) {
      await host.fs.remove(clone, { recursive: true });
      host.audit({ kind: "fs", op: "delete", path: clone });
    }
    return read;
  }
  return ok({ ref, position, file, entries: read.value }, [...refreshed.warnings, ...read.warnings]);
}

export async function applyAddCatalog(ctx: RegisterCtx, plan: AddCatalogPlan): Promise<Result<CatalogRef[]>> {
  let duplicate = false;
  const saved = await ctx.config.updateConfig((c) => {
    if (c.catalogs.some((x) => x.id === plan.ref.id)) {
      duplicate = true;
      return c;
    }
    return { ...c, catalogs: plan.position === "first" ? [plan.ref, ...c.catalogs] : [...c.catalogs, plan.ref] };
  });
  if (!saved.ok) return saved;
  if (duplicate) return err({ code: "STALE_PLAN", message: `catalog '${plan.ref.id}' was registered meanwhile` });
  return ok(saved.value.catalogs);
}

/** §3.20 with A18: a path without a .yaml suffix is a folder that gets a library.yaml. */
export async function initCatalog(
  ctx: RegisterCtx,
  req: { path: string; id?: string; position?: "first" | "last" },
): Promise<Result<{ created: string; catalogs: CatalogRef[] }>> {
  const { host } = ctx;
  const id = (req.id ?? "personal").trim();
  if (!req.path.startsWith("/") && !req.path.startsWith("~")) return refuse(id, `path '${req.path}' must be absolute or start with '~'`);
  const expanded = expandHome(req.path, host.paths.home);
  const isDir = (await host.fs.stat(expanded).then((s) => s.kind, () => null)) === "dir";
  const file = isDir || !/\.ya?ml$/i.test(expanded) ? `${expanded.replace(/\/+$/, "")}/library.yaml` : expanded;
  if (await host.fs.exists(file)) return err({ code: "DUPLICATE", message: `${file} already exists; register it instead of creating it` });

  await host.fs.mkdirp(file.slice(0, file.lastIndexOf("/")));
  await host.fs.writeTextAtomic(file, scaffoldCatalog(id));
  host.audit({ kind: "fs", op: "write", path: file });
  const undo = async () => {
    await host.fs.remove(file);
    host.audit({ kind: "fs", op: "delete", path: file });
  };
  const plan = await planAddCatalog(ctx, { kind: "local", id, path: file, ...(req.position && { position: req.position }) });
  if (!plan.ok) {
    await undo();
    return plan;
  }
  const applied = await applyAddCatalog(ctx, plan.value);
  if (!applied.ok) {
    await undo();
    return applied;
  }
  return ok({ created: file, catalogs: applied.value });
}

export interface RemoveCatalogReport {
  purgedClone: boolean;
  /** A19: global destinations deleted */
  purgedInstalls: string[];
  clearedReceipts: number;
}

export async function removeCatalog(
  ctx: RegisterCtx & { receipts: ReceiptStore; settings: ClaudeSettings },
  req: { id: string; purgeClone?: boolean; purgeInstalls?: boolean },
): Promise<Result<RemoveCatalogReport>> {
  const { host } = ctx;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const catalogs = loaded.value.config.catalogs;
  const ref = catalogs.find((c) => c.id === req.id);
  if (!ref) return err({ code: "UNKNOWN_CATALOG", message: `unknown catalog '${req.id}' (registered: ${catalogs.map((c) => c.id).join(", ")})` });
  if (catalogs.length === 1) return err({ code: "REFUSED", message: `'${req.id}' is the only catalog; register another before removing it` });
  const key = ref.kind === "remote" ? `${ref.repo}#${ref.yamlPath}@${ref.branch}` : await host.fs.realPath(await localFile(host, ref.path)).catch(() => null);

  // The config first, as the CLI does: whatever happens to the files next, the catalog is gone.
  const saved = await ctx.config.updateConfig((c) => ({ ...c, catalogs: c.catalogs.filter((x) => x.id !== req.id) }));
  if (!saved.ok) return saved;

  const report: RemoveCatalogReport = { purgedClone: false, purgedInstalls: [], clearedReceipts: 0 };
  const warnings: Warning[] = [];
  if (req.purgeInstalls) {
    const receipts = await ctx.receipts.all();
    if (!receipts.ok) return receipts;
    const dirs = Object.values(installDirs(host.paths.home));
    const off: Record<string, null> = {};
    for (const r of receipts.value) {
      if (r.catalog.key !== key && r.catalog.id !== req.id) continue;
      // A19: global destinations only; a receipt anywhere else is left alone.
      if (!dirs.some((d) => r.dest.startsWith(d + "/"))) continue;
      if (await host.fs.exists(r.dest)) {
        await host.fs.remove(r.dest, { recursive: true });
        host.audit({ kind: "fs", op: "delete", path: r.dest });
        report.purgedInstalls.push(r.dest);
        if (r.type !== "agent") off[r.name] = null;
      }
      const dropped = await ctx.receipts.delete(r.dest);
      if (!dropped.ok) return dropped;
      report.clearedReceipts++;
    }
    // Q17 A, as uninstall does: an "off" must not outlive the skill it hid.
    if (Object.keys(off).length > 0) {
      const edited = await ctx.settings.editSkillOverrides(off);
      if (!edited.ok) warnings.push({ message: `removed, but the skillOverrides entries were left: ${edited.error.message}` });
    }
  }
  if (req.purgeClone && ref.kind === "remote") {
    const clone = cloneDir(host, ref.id);
    if (await host.fs.exists(clone)) {
      await host.fs.remove(clone, { recursive: true });
      host.audit({ kind: "fs", op: "delete", path: clone });
      report.purgedClone = true;
    }
  }
  return ok(report, warnings);
}
