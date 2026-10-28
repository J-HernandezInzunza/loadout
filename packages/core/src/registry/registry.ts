// The registered catalogs and their entries, in precedence order (behaviors.md §1.3). Loading reads
// local files and existing clones only: it never clones, pulls or runs anything (RCAT-02, RCAT-09).
import { catalogEntries, parseCatalog, type EntryProblem } from "../catalog/read.ts";
import type { AppConfigV1 } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type CatalogRef, type Entry, type Result } from "../model/model.ts";
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

  const entries = (): Result<Entry[]> => {
    const skipped = all.filter((c) => c.skipped !== undefined);
    if (all.length > 0 && active.length === 0) {
      const message =
        all.length === 1 ? all[0]!.skipped! : `no readable catalog: ${skipped.map((c) => `${c.ref.id} (${c.skipped})`).join("; ")}`;
      return err({ code: "NO_READABLE_CATALOG", message });
    }
    // Per-catalog warnings only when several are registered, so one catalog's reason is not said twice.
    const warnings = all.length > 1 ? skipped.map((c) => ({ message: `catalog '${c.ref.id}' skipped: ${c.skipped}` })) : [];
    return ok(
      active.flatMap((c) => c.entries),
      warnings,
    );
  };

  return {
    catalogs: () => all,
    active: () => active,
    writable: () => active.filter((c) => c.ref.writable !== false),
    entries,
    entriesOf: (id) => all.find((c) => c.ref.id === id)?.entries ?? [],
    winners() {
      const winners = new Map<string, Entry>();
      for (const e of active.flatMap((c) => c.entries)) if (!winners.has(e.name)) winners.set(e.name, e);
      return winners;
    },
  };
}
