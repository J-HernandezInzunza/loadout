// Dependencies between entries of one catalog (behaviors.md §2.2). A ref `type:name` is looked up
// only in the requiring entry's own catalog (DEP-02); callers pass that catalog's entries.
import { pyLess, strip } from "../catalog/python.ts";
import type { Entry, Warning } from "../model/model.ts";

/** A25: no `:` is malformed; a ref that names nothing here, unknown type included, is not_found. */
export type Unresolved = { ref: string; requiredBy: string; reason: "malformed" | "not_found" | "cycle" };

const key = (e: { type: string; name: string }) => `${e.type}:${e.name}`;

/** Split on the first `:`, both halves stripped; undefined when there is no `:`. */
export function parseRef(ref: string): { type: string; name: string } | undefined {
  const colon = ref.indexOf(":");
  if (colon < 0) return undefined;
  return { type: strip(ref.slice(0, colon)), name: strip(ref.slice(colon + 1)) };
}

export function lookup(entries: Entry[], ref: string): Entry | undefined {
  const parsed = parseRef(ref);
  return parsed && entries.find((e) => e.type === parsed.type && e.name === parsed.name);
}

/** DEP-01: depth-first post-order over refs in list order; the target last, each (type, name) once. */
export function resolveDeps(entries: Entry[], target: Entry): { order: Entry[]; unresolved: Unresolved[]; warnings: Warning[] } {
  const order: Entry[] = [];
  const unresolved: Unresolved[] = [];
  const warnings: Warning[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (entry: Entry): void => {
    visiting.add(key(entry));
    for (const ref of entry.requires) {
      if (!parseRef(ref)) {
        warnings.push({ message: `malformed dependency ref '${ref}' on ${key(entry)}` });
        unresolved.push({ ref, requiredBy: entry.name, reason: "malformed" });
        continue;
      }
      const dep = lookup(entries, ref);
      if (!dep) {
        warnings.push({ message: `dependency ${ref} not found in catalog (required by ${entry.name})` });
        unresolved.push({ ref, requiredBy: entry.name, reason: "not_found" });
        continue;
      }
      if (visiting.has(key(dep))) {
        // A29: the parent that re-entered the cycle, not the re-entered node.
        warnings.push({ message: `dependency cycle detected at ${key(dep)}; skipping re-entry` });
        unresolved.push({ ref: key(dep), requiredBy: entry.name, reason: "cycle" });
        continue;
      }
      if (!done.has(key(dep))) visit(dep);
    }
    visiting.delete(key(entry));
    done.add(key(entry));
    order.push(entry);
  };

  visit(target);
  return { order, unresolved, warnings };
}

/** DEP-06: closures of several requested entries, in request order, each (type, name) once. */
export function mergeOrders(orders: Entry[][]): Entry[] {
  const seen = new Set<string>();
  return orders.flat().filter((e) => {
    if (seen.has(key(e))) return false;
    seen.add(key(e));
    return true;
  });
}

/**
 * DEP-08: entries whose closure reaches the target, found breadth-first; sorted direct first, then
 * by type, then by name. Malformed refs are skipped silently.
 */
export function dependents(entries: Entry[], target: Entry): { entry: Entry; direct: boolean }[] {
  const found: { entry: Entry; direct: boolean }[] = [];
  const seen = new Set([key(target)]);
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of entries) {
      if (seen.has(key(e)) || !e.requires.some((ref) => lookup(entries, ref) === current)) continue;
      seen.add(key(e));
      found.push({ entry: e, direct: current === target });
      queue.push(e);
    }
  }
  const cmp = (a: string, b: string) => (pyLess(a, b) ? -1 : pyLess(b, a) ? 1 : 0);
  return found.sort((a, b) => Number(b.direct) - Number(a.direct) || cmp(a.entry.type, b.entry.type) || cmp(a.entry.name, b.entry.name));
}

/** Every dependency cycle in a catalog, once each, as `type:name` paths that end where they start. */
export function findCycles(entries: Entry[]): string[][] {
  const cycles: string[][] = [];
  const done = new Set<string>();
  const path: Entry[] = [];

  const visit = (entry: Entry): void => {
    path.push(entry);
    for (const ref of entry.requires) {
      const dep = lookup(entries, ref);
      if (!dep) continue;
      const at = path.indexOf(dep);
      if (at >= 0) cycles.push([...path.slice(at), dep].map(key));
      else if (!done.has(key(dep))) visit(dep);
    }
    path.pop();
    done.add(key(entry));
  };

  for (const entry of entries) if (!done.has(key(entry))) visit(entry);
  return cycles;
}
