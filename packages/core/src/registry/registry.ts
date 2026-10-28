// The registered catalogs and their entries, in precedence order (behaviors.md §1.3). Loading reads
// local files and existing clones only: it never clones, pulls or runs anything (RCAT-02, RCAT-09).
import { catalogEntries, parseCatalog, type EntryProblem } from "../catalog/read.ts";
import type { AppConfigV1 } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type CatalogRef, type CoreError, type Entry, type Result } from "../model/model.ts";
import { expandHome } from "../source/source.ts";

export interface CatalogState {
  ref: CatalogRef;
  /** the catalog's library.yaml */
  file: string;
  /** why the catalog could not be read this run */
  skipped?: string;
  entries: Entry[];
  problems: EntryProblem[];
}

export type Candidate = Pick<Entry, "type" | "name" | "description" | "catalog">;

/** No exact match: AMBIGUOUS_NAME when there are candidates to choose from (RES-04). */
export type NameErr = CoreError & { code: "NOT_FOUND" | "AMBIGUOUS_NAME"; query: string; candidates: Candidate[] };

export type ResolveErr = NameErr | CoreError;

export interface Registry {
  /** every registered catalog, highest precedence first, skipped ones included */
  catalogs(): CatalogState[];
  active(): CatalogState[];
  writable(): CatalogState[];
  /** all active entries in precedence order; fails only when no catalog could be read (RCAT-08) */
  entries(): Result<Entry[]>;
  entriesOf(id: string): Entry[];
  /** name → the first entry of that name in precedence order, whatever its type (RES-18) */
  winners(): Map<string, Entry>;
  /** The first entry named exactly `name`; with `catalog`, only that active catalog is searched (RES-06). */
  resolve(name: string, catalog?: string): Result<Entry, ResolveErr>;
  /** Every name resolved before anything is returned, so a caller acts on all or none (RES-05). */
  resolveAll(names: string[], catalog?: string): Result<Entry[], ResolveErr>;
  /** Entries whose name or description contains the query, case-insensitively (RES-04). */
  candidates(query: string, catalog?: string): Candidate[];
}

/**
 * §1.6, RES-10, RES-11: a pin moves its catalog's copies of the name to the front of the slots that
 * name occupies; nothing else moves. A pin to a catalog that is absent, skipped or lacks the name is inert.
 */
function applyPins(entries: Entry[], pins: Record<string, string>): Entry[] {
  const out = [...entries];
  for (const [name, catalog] of Object.entries(pins)) {
    const slots = out.flatMap((e, i) => (e.name === name ? [i] : []));
    const named = slots.map((i) => out[i]!);
    const reordered = [...named.filter((e) => e.catalog === catalog), ...named.filter((e) => e.catalog !== catalog)];
    slots.forEach((slot, k) => (out[slot] = reordered[k]!));
  }
  return out;
}

async function catalogFile(host: Host, ref: CatalogRef): Promise<{ file: string; missing?: string }> {
  if (ref.kind === "remote") {
    const clone = `${host.paths.appData}/clones/${ref.id}`;
    const file = `${clone}/${ref.yamlPath}`;
    return (await host.fs.exists(clone)) ? { file } : { file, missing: `not cloned yet at ${clone}` };
  }
  const path = expandHome(ref.path, host.paths.home);
  const kind = await host.fs.stat(path).then((s) => s.kind, () => undefined);
  return kind === "dir" ? { file: `${path}/library.yaml` } : { file: path };
}

async function readCatalog(host: Host, ref: CatalogRef): Promise<CatalogState> {
  const { file, missing } = await catalogFile(host, ref);
  const skip = (skipped: string): CatalogState => ({ ref, file, skipped, entries: [], problems: [] });
  if (missing) return skip(missing);
  if (!(await host.fs.exists(file))) return skip(`not found at ${file}`);
  let text: string;
  try {
    text = await host.fs.readText(file);
  } catch (e) {
    return skip(`can't read ${file}: ${(e as Error).message}`);
  }
  const parsed = parseCatalog(text);
  if (!parsed.ok) {
    const { message, line } = parsed.problem;
    return skip(`can't parse ${file}: ${message}${line === undefined ? "" : ` (line ${line})`}`);
  }
  return { ref, file, ...catalogEntries(parsed.data, ref.id) };
}

export async function loadRegistry(host: Host, config: AppConfigV1): Promise<Registry> {
  const all = await Promise.all(config.catalogs.map((ref) => readCatalog(host, ref)));
  const active = all.filter((c) => c.skipped === undefined);
  const merged = applyPins(active.flatMap((c) => c.entries), config.pins);

  const entries = (): Result<Entry[]> => {
    const skipped = all.filter((c) => c.skipped !== undefined);
    if (all.length > 0 && active.length === 0) {
      const message =
        all.length === 1 ? all[0]!.skipped! : `no readable catalog: ${skipped.map((c) => `${c.ref.id} (${c.skipped})`).join("; ")}`;
      return err({ code: "NO_READABLE_CATALOG", message });
    }
    // Per-catalog warnings only when several are registered, so one catalog's reason is not said twice.
    const warnings = all.length > 1 ? skipped.map((c) => ({ message: `catalog '${c.ref.id}' skipped: ${c.skipped}` })) : [];
    return ok(merged, warnings);
  };

  /** The entries a lookup searches: one active catalog's, or the pinned merge of all. */
  const scope = (catalog?: string): Result<Entry[]> => {
    if (catalog === undefined) return entries();
    const found = active.find((c) => c.ref.id === catalog);
    if (found) return ok(found.entries);
    const available = active.map((c) => c.ref.id).join(", ") || "none";
    return err({ code: "UNKNOWN_CATALOG", message: `unknown catalog '${catalog}' (available: ${available})` });
  };

  const candidatesIn = (searched: Entry[], query: string): Candidate[] => {
    const q = query.toLowerCase();
    return searched
      .filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
      .map(({ type, name, description, catalog }) => ({ type, name, description, catalog }));
  };

  const resolve = (name: string, catalog?: string): Result<Entry, ResolveErr> => {
    const searched = scope(catalog);
    if (!searched.ok) return searched;
    const found = searched.value.find((e) => e.name === name);
    if (found) return ok(found, searched.warnings);
    const candidates = candidatesIn(searched.value, name);
    const error: NameErr = candidates.length
      ? { code: "AMBIGUOUS_NAME", message: `no entry is named exactly '${name}'; did you mean one of these?`, query: name, candidates }
      : { code: "NOT_FOUND", message: `no entry named '${name}'`, query: name, candidates };
    return err(error, searched.warnings);
  };

  return {
    catalogs: () => all,
    active: () => active,
    writable: () => active.filter((c) => c.ref.writable !== false),
    entries,
    entriesOf: (id) => all.find((c) => c.ref.id === id)?.entries ?? [],
    winners() {
      const winners = new Map<string, Entry>();
      for (const e of merged) if (!winners.has(e.name)) winners.set(e.name, e);
      return winners;
    },
    resolve,
    resolveAll(names, catalog) {
      const found: Entry[] = [];
      for (const name of names) {
        const result = resolve(name, catalog);
        if (!result.ok) return result;
        found.push(result.value);
      }
      return ok(found, scope(catalog).warnings);
    },
    candidates(query, catalog) {
      const searched = scope(catalog);
      return searched.ok ? candidatesIn(searched.value, query) : [];
    },
  };
}
