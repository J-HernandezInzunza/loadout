// The registry checks of library.py's Config.problems (MIG-01), run on a parsed config.local.yaml
// (mappings as Maps, so keys keep their YAML types) before the one-time import.
import { pyRepr, strip } from "../catalog/python.ts";

type Mapping = Map<unknown, unknown>;
const isMapping = (v: unknown): v is Mapping => v instanceof Map;

/** Python truthiness, for the CLI's `raw.get(key)` checks. */
const truthy = (v: unknown) =>
  !(v === null || v === undefined || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (isMapping(v) && v.size === 0));

/** Python's str() of a YAML scalar. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v instanceof Date) return v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString();
  return String(v);
}

/** Python's repr() of a YAML scalar, for pin keys. */
const reprOf = (v: unknown) => (typeof v === "string" ? pyRepr(v) : pyStr(v));

function catalogProblems(items: unknown[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const clones = new Map<string, string>();
  items.forEach((item, i) => {
    if (!isMapping(item)) {
      problems.push(`catalogs[${i}] is not a mapping`);
      return;
    }
    const id = strip(truthy(item.get("id")) ? pyStr(item.get("id")) : "");
    if (!id) {
      problems.push(`catalogs[${i}] has no 'id'`);
      return;
    }
    if (ids.has(id)) problems.push(`duplicate catalog id '${id}'`);
    ids.add(id);

    const [path, repo] = [item.get("path"), item.get("repo")];
    if (truthy(path) && truthy(repo)) {
      problems.push(`catalog '${id}' declares both 'path' and 'repo' — pick one`);
      return;
    }
    if (!truthy(path) && !truthy(repo)) {
      problems.push(`catalog '${id}' declares neither 'path' nor 'repo'`);
      return;
    }
    if (truthy(path)) {
      const p = pyStr(path);
      if (!p.startsWith("/") && !p.startsWith("~")) problems.push(`catalog '${id}' path '${p}' must be absolute or start with '~'`);
      return;
    }

    const [yamlPath, branch] = [item.get("yaml_path"), item.get("branch")];
    if (!truthy(yamlPath)) problems.push(`remote catalog '${id}' has no 'yaml_path'`);
    if (!truthy(branch)) problems.push(`remote catalog '${id}' has no 'branch'`);
    if (truthy(yamlPath)) {
      const y = pyStr(yamlPath);
      if (y.startsWith("/") || y.split("/").includes("..") || y.includes(":")) {
        problems.push(`catalog '${id}' has invalid yaml_path '${y}': use a relative path inside the repo (no leading '/', no '..', no ':')`);
      }
    }
    if (truthy(branch)) {
      const clone = `${pyStr(repo)}\0${pyStr(branch)}`;
      const other = clones.get(clone);
      if (other === undefined) clones.set(clone, id);
      else problems.push(`catalogs '${id}' and '${other}' share repo and branch; they would contend for one clone`);
    }
  });
  return problems;
}

function pinProblems(pins: unknown): string[] {
  if (!truthy(pins)) return [];
  if (!isMapping(pins)) return ["'pins:' is not a mapping of entry name to catalog id"];
  const problems: string[] = [];
  for (const [name, catalog] of pins) {
    if (typeof name !== "string" || !strip(name)) problems.push(`pin key ${reprOf(name)} is not an entry name`);
    else if (typeof catalog !== "string" || !strip(catalog)) problems.push(`pin ${pyRepr(name)} does not name a catalog`);
  }
  return problems;
}

/** Problems in registry order; empty means the config can be imported. */
export function validateRegistry(raw: unknown): string[] {
  const data: Mapping = isMapping(raw) ? raw : new Map();
  const problems: string[] = [];
  const [legacy, modern] = [data.has("catalog"), data.has("catalogs")];
  if (legacy && modern) {
    problems.push("both 'catalog:' and 'catalogs:' are present — keep one; they are ambiguous");
  } else if (!legacy && !modern) {
    problems.push("neither 'catalog:' nor 'catalogs:' is present");
  } else if (legacy) {
    const catalog = data.get("catalog");
    if (!isMapping(catalog)) problems.push("'catalog:' is not a mapping");
    else {
      const missing = ["repo", "yaml_path", "branch"].filter((k) => !truthy(catalog.get(k)));
      if (missing.length > 0) problems.push(`missing ${missing.map((k) => `catalog.${k}`).join(", ")}`);
      else problems.push(...catalogProblems([new Map([["id", "shared"], ...catalog])]));
    }
  } else {
    const items = data.get("catalogs");
    if (!Array.isArray(items)) problems.push("'catalogs:' is not a list");
    else if (items.length === 0) problems.push("'catalogs:' is empty");
    else problems.push(...catalogProblems(items));
  }
  return [...problems, ...pinProblems(data.get("pins"))];
}
