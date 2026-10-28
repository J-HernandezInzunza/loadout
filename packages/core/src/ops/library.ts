// The core's facade (architecture.md §2.3): one instance per host, no state shared between
// instances. Reads load config and catalogs each call and never touch the network.
import { createConfigStore } from "../config/config.ts";
import { dependents, resolveDeps } from "../deps/deps.ts";
import type { Host } from "../host.ts";
import { LibraryError, ok, type Entry, type Result } from "../model/model.ts";
import { loadRegistry, type EntryRecord, type Registry, type ResolveErr } from "../registry/registry.ts";
import { cloneUrls, parseSource } from "../source/source.ts";
import type { CatalogRow, EntryDetail } from "./schemas.ts";

export interface Library {
  /** Every copy of every entry, in resolution order. */
  list(opts?: { catalog?: string }): Promise<Result<EntryRecord[]>>;
  /** W18: the list filtered by name or description, case-insensitively, as RES-04's candidates are. */
  search(query: string, opts?: { catalog?: string }): Promise<Result<EntryRecord[]>>;
  show(name: string, opts?: { catalog?: string }): Promise<Result<EntryDetail, ResolveErr>>;
  catalogs(): Promise<Result<CatalogRow[]>>;
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

export function createLibrary(host: Host): Library {
  const store = createConfigStore(host);

  const registry = async (): Promise<Result<Registry>> => {
    const loaded = await store.loadConfig();
    if (!loaded.ok) return loaded;
    return ok(await loadRegistry(host, loaded.value.config));
  };

  const records = async (catalog?: string): Promise<Result<EntryRecord[]>> => {
    const r = await registry();
    if (!r.ok) return r;
    const scope = r.value.searchScope(catalog);
    if (!scope.ok) return scope;
    const all = r.value.records();
    return ok(catalog === undefined ? all : all.filter((e) => e.catalog === catalog), scope.warnings);
  };

  return {
    list: (opts = {}) => records(opts.catalog),

    async search(query, opts = {}) {
      const found = await records(opts.catalog);
      if (!found.ok) return found;
      const q = query.toLowerCase();
      const matches = found.value.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
      return ok(matches, found.warnings);
    },

    async show(name, opts = {}) {
      const r = await registry();
      if (!r.ok) return r;
      const reg = r.value;
      const resolved = reg.resolve(name, opts.catalog);
      if (!resolved.ok) return resolved;
      const subject = resolved.value;
      const own = reg.entriesOf(subject.catalog);
      const deps = resolveDeps(own, subject);
      const entry = reg.records().find((e) => e.catalog === subject.catalog && e.type === subject.type && e.name === subject.name)!;
      return ok(
        {
          name,
          entry,
          copies: reg.copies(name, subject.catalog),
          requires: deps.order.filter((e) => e !== subject).map(ref),
          unresolvedRequires: deps.unresolved,
          dependents: dependents(own, subject).map(({ entry: e, direct }) => ({ ...ref(e), direct })),
          source: shownSource(subject.source, host.paths.home),
        },
        [...resolved.warnings, ...deps.warnings],
      );
    },

    async catalogs() {
      const r = await registry();
      if (!r.ok) return r;
      return ok(
        r.value.catalogs().map((c, i) => ({
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
  };
}
