// Which catalog a write lands in (WRITE-01..04). An add goes to the named catalog, or to the only
// writable one (no default_add_catalog in the rebuild, Q11); an update or remove goes to the catalog
// the entry resolved from. More than one candidate is AMBIGUOUS_CATALOG, a typed decision with the
// choices, never a guess (WRITE-03).
import { err, ok, type CoreError, type Entry, type EntryType, type Result } from "../model/model.ts";
import type { CatalogState, Registry } from "../registry/registry.ts";

export type AmbiguousCatalog = CoreError & { code: "AMBIGUOUS_CATALOG"; catalogs: string[] };
export type WriteTargetErr = AmbiguousCatalog | CoreError;

export type WriteTargetReq =
  | { op: "add"; catalog?: string }
  | { op: "update" | "remove"; name: string; type?: EntryType; catalog?: string };

export interface WriteTarget {
  catalog: CatalogState;
  /** update and remove: the entry being edited */
  entry?: Entry;
}

function named(registry: Registry, id: string): Result<CatalogState> {
  const active = registry.active();
  const found = active.find((c) => c.ref.id === id);
  if (!found) return err({ code: "UNKNOWN_CATALOG", message: `unknown catalog '${id}' (available: ${active.map((c) => c.ref.id).join(", ") || "none"})` });
  return found.ref.writable === false ? err({ code: "READ_ONLY", message: `catalog '${id}' is read-only (writable: false)` }) : ok(found);
}

const ambiguous = (catalogs: string[], what: string): Result<never, AmbiguousCatalog> =>
  err({ code: "AMBIGUOUS_CATALOG", message: `${what} could go to ${catalogs.map((c) => `'${c}'`).join(" or ")}; choose a catalog`, catalogs });

export function writeTarget(registry: Registry, req: WriteTargetReq): Result<WriteTarget, WriteTargetErr> {
  if (req.op === "add") {
    // WRITE-01
    if (req.catalog !== undefined) {
      const c = named(registry, req.catalog);
      return c.ok ? ok({ catalog: c.value }) : c;
    }
    // WRITE-02 (rebuild)
    const writable = registry.writable();
    if (writable.length === 0) return err({ code: "NO_WRITABLE_CATALOG", message: "no writable catalog is configured; nothing can be written" });
    if (writable.length > 1) return ambiguous(writable.map((c) => c.ref.id), "a new entry");
    return ok({ catalog: writable[0]! });
  }

  // WRITE-04: the catalog the entry resolved from; several holders is a decision for the caller.
  const matches = (e: Entry) => e.name === req.name && (req.type === undefined || e.type === req.type);
  const holders = registry.active().filter((c) => c.entries.some(matches));
  if (req.catalog !== undefined) {
    const c = named(registry, req.catalog);
    if (!c.ok) return c;
    const entry = c.value.entries.find(matches);
    if (!entry) return err({ code: "NOT_FOUND", message: `'${req.name}' is not in catalog '${req.catalog}'${holders.length > 0 ? ` (it is in: ${holders.map((h) => h.ref.id).join(", ")})` : ""}` });
    return ok({ catalog: c.value, entry });
  }
  if (holders.length === 0) {
    const close = registry.candidates(req.name).map((c) => c.name);
    return err({ code: "NOT_FOUND", message: `no entry named '${req.name}'${close.length > 0 ? ` (did you mean: ${[...new Set(close)].join(", ")}?)` : ""}` });
  }
  if (holders.length > 1) return ambiguous(holders.map((h) => h.ref.id), `'${req.name}'`);
  const only = holders[0]!;
  if (only.ref.writable === false) return err({ code: "READ_ONLY", message: `catalog '${only.ref.id}' is read-only (writable: false)` });
  return ok({ catalog: only, entry: only.entries.find(matches)! });
}
