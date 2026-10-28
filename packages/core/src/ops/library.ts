// The core's facade (architecture.md §2.3): one instance per host, no state shared between
// instances. Reads load config, catalogs and the install dirs each call and never touch the network,
// except list({ checkRemote }) (UPD-06) and refresh().
import { refreshCatalogs, type CatalogRefresh } from "../catalogs/catalogs.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { createConfigStore } from "../config/config.ts";
import { dependents, resolveDeps } from "../deps/deps.ts";
import { createGitClient, type GitClient } from "../git/git.ts";
import { createOperation } from "../git/operation.ts";
import type { Host } from "../host.ts";
import { LibraryError, ok, type Entry, type Result, type Warning } from "../model/model.ts";
import { createReceiptStore, type ReceiptV2 } from "../receipts/receipts.ts";
import { loadRegistry, type EntryRecord, type Registry, type ResolveErr } from "../registry/registry.ts";
import { destFor, destState, readLegacyInstalls, scanInstallDirs, type ScanReport } from "../scan/scan.ts";
import { cloneUrls, parseSource } from "../source/source.ts";
import { isStale } from "../update/update.ts";
import type { CatalogRow, EntryDetail } from "./schemas.ts";

export interface Library {
  /** Every copy of every entry, in resolution order; `checkRemote` asks each installed remote source whether it moved (UPD-06). */
  list(opts?: { catalog?: string; checkRemote?: boolean }): Promise<Result<EntryRecord[]>>;
  /** W18: the list filtered by name or description, case-insensitively, as RES-04's candidates are. */
  search(query: string, opts?: { catalog?: string }): Promise<Result<EntryRecord[]>>;
  show(name: string, opts?: { catalog?: string }): Promise<Result<EntryDetail, ResolveErr>>;
  catalogs(): Promise<Result<CatalogRow[]>>;
  /** What the install dirs hold, managed or not (architecture.md §4.4). */
  scan(): Promise<Result<ScanReport>>;
  /** Clone or fast-forward every remote catalog (RCAT-03); per-catalog failures are warnings. */
  refresh(): Promise<Result<CatalogRefresh[]>>;
}

export interface LibraryOptions {
  git?: GitClient;
  /** CLAUDE_CONFIG_DIR, as the app's login-shell probe found it */
  claudeConfigDir?: string;
}

const ref = (e: Entry) => ({ type: e.type, name: e.name, catalog: e.catalog, description: e.description });

function shownSource(raw: string, home: string): EntryDetail["source"] {
  try {
    const src = parseSource(raw, home);
    return src.kind === "local" ? { raw, kind: "local", path: src.path } : { raw, ...src, cloneUrls: cloneUrls(src) };
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { raw, kind: "unknown", error: e.message };
  }
}

/** Everything a read needs about installs, loaded once per call. */
interface InstallView {
  byDest: Map<string, ReceiptV2>;
  receipts: ReceiptV2[];
  legacy: Map<string, string>;
  overrides: Map<string, string>;
  warnings: Warning[];
}

export function createLibrary(host: Host, opts: LibraryOptions = {}): Library {
  const store = createConfigStore(host);
  const receiptStore = createReceiptStore(host);
  const settings = createClaudeSettings(host, opts.claudeConfigDir === undefined ? {} : { configDir: opts.claudeConfigDir });
  const git = opts.git ?? createGitClient(host);
  const home = host.paths.home;

  const loadAll = async (): Promise<Result<{ reg: Registry; view: InstallView; installs: string | undefined }>> => {
    const loaded = await store.loadConfig();
    if (!loaded.ok) return loaded;
    const reg = await loadRegistry(host, loaded.value.config);
    const receipts = await receiptStore.all();
    if (!receipts.ok) return receipts;
    const overrides = await settings.readSkillOverrides();
    const installs = loaded.value.config.imported?.installs;
    const view: InstallView = {
      byDest: new Map(receipts.value.map((r) => [r.dest, r])),
      receipts: receipts.value,
      legacy: await readLegacyInstalls(host, installs),
      overrides: overrides.ok ? overrides.value : new Map(),
      warnings: [...receipts.warnings, ...(overrides.ok ? [] : [{ message: `on/off state unknown: ${overrides.error.message}` }])],
    };
    return ok({ reg, view, installs });
  };

  /** The destination's real install fields for `entry`, whichever copy it is. */
  const installFields = async (entry: Entry, view: InstallView) => {
    const dest = destFor(home, entry.type, entry.name);
    const state = await destState(host, dest, view.byDest.get(dest) ?? null, view.legacy);
    return {
      installed: state.state !== "absent",
      state: state.state === "absent" ? ("not_installed" as const) : state.state,
      receipt: "receipt" in state ? state.receipt : null,
      locations: state.state === "absent" ? [] : [dest],
      disabled: entry.type !== "agent" && view.overrides.get(entry.name) === "off",
    };
  };

  /** RES-07: only the winning copy of a name carries its install; the others keep the registry's not-installed record. */
  const records = async (reg: Registry, view: InstallView, catalog?: string): Promise<EntryRecord[]> => {
    const all = reg.records().filter((e) => catalog === undefined || e.catalog === catalog);
    return Promise.all(all.map(async (e) => (e.overriddenBy === null ? { ...e, ...(await installFields(e, view)) } : e)));
  };

  const listed = async (catalog?: string) => {
    const all = await loadAll();
    if (!all.ok) return all;
    const { reg, view } = all.value;
    const scope = reg.searchScope(catalog);
    if (!scope.ok) return scope;
    return ok({ reg, view, records: await records(reg, view, catalog) }, [...scope.warnings, ...view.warnings]);
  };

  return {
    async list(o = {}) {
      const found = await listed(o.catalog);
      if (!found.ok) return found;
      const list = found.value.records;
      if (o.checkRemote) {
        const op = await createOperation(host, git);
        try {
          for (const r of list) {
            if (r.state === "installed" && r.receipt && (await isStale({ host, op, receipts: receiptStore }, r, r.receipt))) r.state = "stale";
          }
        } finally {
          await op.dispose();
        }
      }
      return ok(list, found.warnings);
    },

    async search(query, o = {}) {
      const found = await listed(o.catalog);
      if (!found.ok) return found;
      const q = query.toLowerCase();
      const matches = found.value.records.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
      return ok(matches, found.warnings);
    },

    async show(name, o = {}) {
      const all = await loadAll();
      if (!all.ok) return all;
      const { reg, view } = all.value;
      const resolved = reg.resolve(name, o.catalog);
      if (!resolved.ok) return resolved;
      const subject = resolved.value;
      const own = reg.entriesOf(subject.catalog);
      const deps = resolveDeps(own, subject);
      const record = reg.records().find((e) => e.catalog === subject.catalog && e.type === subject.type && e.name === subject.name)!;
      return ok(
        {
          name,
          // RES-08: the subject's install fields as if it won, even when another copy does.
          entry: { ...record, ...(await installFields(subject, view)) },
          copies: reg.copies(name, subject.catalog),
          requires: deps.order.filter((e) => e !== subject).map(ref),
          unresolvedRequires: deps.unresolved,
          dependents: dependents(own, subject).map(({ entry: e, direct }) => ({ ...ref(e), direct })),
          installs: view.receipts.filter((r) => r.name === subject.name && r.type === subject.type),
          source: shownSource(subject.source, home),
        },
        [...resolved.warnings, ...deps.warnings, ...view.warnings],
      );
    },

    async catalogs() {
      const loaded = await store.loadConfig();
      if (!loaded.ok) return loaded;
      const reg = await loadRegistry(host, loaded.value.config);
      return ok(
        reg.catalogs().map((c, i) => ({
          precedence: i + 1,
          id: c.ref.id,
          kind: c.ref.kind,
          location: c.ref.kind === "remote" ? `${c.ref.repo} (${c.ref.branch}, ${c.ref.yamlPath})` : c.file,
          writeMode: c.ref.kind === "local" ? "local" : c.ref.protected ? "pr" : "direct",
          writable: c.ref.writable !== false,
          entries: c.skipped === undefined ? c.entries.length : null,
          skipped: c.skipped ?? null,
        })),
      );
    },

    async scan() {
      const all = await loadAll();
      if (!all.ok) return all;
      const { reg, installs } = all.value;
      const entries = reg.entries();
      const known = new Set((entries.ok ? entries.value : []).map((e) => `${e.type}:${e.name}`));
      return scanInstallDirs(host, receiptStore, {
        ...(installs !== undefined && { legacyInstalls: installs }),
        inCatalog: (type, name) => known.has(`${type}:${name}`),
      });
    },

    async refresh() {
      const loaded = await store.loadConfig();
      if (!loaded.ok) return loaded;
      return refreshCatalogs(host, git, loaded.value.config.catalogs);
    },
  };
}
