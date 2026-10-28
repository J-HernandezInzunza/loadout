// Reading catalog files the way the CLI does (behaviors.md §1.4, §1.12): YAML 1.1 as PyYAML's
// safe_load resolves it, then entries in section order. Unlike the CLI, a value of the wrong type
// is a typed problem for that entry, never a crash or a silently wrong value.
import { LineCounter, parseDocument, type ScalarTag } from "yaml";
import { LibraryError, type Entry, type EntryType } from "../model/model.ts";
import { pyLess } from "./python.ts";
import { resolvers } from "./scalar.ts";

export type EntryField = "name" | "description" | "source" | "requires";

export type CatalogProblem =
  | { kind: "parse"; message: string; line?: number }
  | { kind: "structure"; path: string; message: string }
  | { kind: "field"; path: string; field: EntryField; value: unknown; message: string };

const SECTIONS: [EntryType, string][] = [
  ["skill", "skills"],
  ["agent", "agents"],
  ["prompt", "prompts"],
];

/** Python's sign handling in SafeConstructor's int and float constructors. */
function signed(value: string): [number, string] {
  return value[0] === "-" ? [-1, value.slice(1)] : [1, value[0] === "+" ? value.slice(1) : value];
}

const base60 = (parts: number[]) => parts.reduce((total, part) => total * 60 + part, 0);

// The plain-scalar resolvers and constructors of PyYAML's SafeLoader; everything else stays a string.
const pyyamlTags: ScalarTag[] = [
  {
    tag: "tag:yaml.org,2002:null",
    default: true,
    test: resolvers.null,
    resolve: () => null,
  },
  {
    tag: "tag:yaml.org,2002:bool",
    default: true,
    test: resolvers.bool,
    resolve: (s) => ["yes", "true", "on"].includes(s.toLowerCase()),
  },
  {
    tag: "tag:yaml.org,2002:int",
    default: true,
    test: resolvers.int,
    resolve(s) {
      const [sign, v] = signed(s.replaceAll("_", ""));
      if (v === "0") return 0;
      if (v.startsWith("0b")) return sign * parseInt(v.slice(2), 2);
      if (v.startsWith("0x")) return sign * parseInt(v.slice(2), 16);
      if (v.startsWith("0")) return sign * parseInt(v, 8);
      if (v.includes(":")) return sign * base60(v.split(":").map(Number));
      return sign * Number(v);
    },
  },
  {
    tag: "tag:yaml.org,2002:float",
    default: true,
    test: resolvers.float,
    resolve(s) {
      const [sign, v] = signed(s.replaceAll("_", "").toLowerCase());
      if (v === ".inf") return sign * Infinity;
      if (v === ".nan") return NaN;
      if (v.includes(":")) return sign * base60(v.split(":").map(Number));
      return sign * Number(v);
    },
  },
  {
    tag: "tag:yaml.org,2002:timestamp",
    default: true,
    test: resolvers.timestamp,
    resolve(s) {
      const m =
        /^(\d{4})-(\d\d?)-(\d\d?)(?:(?:[Tt]|[ \t]+)(\d\d?):(\d\d):(\d\d)(?:\.(\d*))?(?:[ \t]*(Z|([-+])(\d\d?)(?::(\d\d))?))?)?$/.exec(s)!;
      const [, y, mo, d, h, mi, sec, fraction = "", , tzSign, tzHour = "0", tzMinute = "0"] = m;
      // A date is midnight UTC; a datetime without a zone is read as UTC too.
      const ms = fraction.padEnd(3, "0").slice(0, 3);
      const utc = Date.UTC(+y!, +mo! - 1, +d!, +(h ?? 0), +(mi ?? 0), +(sec ?? 0), +ms);
      const offset = tzSign ? (tzSign === "-" ? -1 : 1) * (+tzHour * 60 + +tzMinute) : 0;
      return new Date(utc - offset * 60_000);
    },
  },
];

/** What catalogEntries reports: the file parsed, but an entry or section has the wrong shape. */
export type EntryProblem = Exclude<CatalogProblem, { kind: "parse" }>;

export type ParsedCatalog = { ok: true; data: unknown } | { ok: false; problem: CatalogProblem & { kind: "parse" } };

/** YAML 1.1 as PyYAML reads it: its implicit types, `<<` merges, and the last of duplicate keys. */
function parseYaml11(text: string, mapAsMap: boolean): ParsedCatalog {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.1",
    schema: "failsafe",
    customTags: pyyamlTags,
    merge: true,
    uniqueKeys: false,
    lineCounter,
  });
  const [error] = doc.errors;
  if (error) {
    const message = error.message.split("\n")[0]!;
    const line = error.linePos?.[0].line;
    return { ok: false, problem: { kind: "parse", message, ...(line !== undefined && { line }) } };
  }
  return { ok: true, data: doc.toJS({ mapAsMap }) };
}

export function parseCatalog(text: string): ParsedCatalog {
  return parseYaml11(text, false);
}

/** Like parseCatalog, with every mapping a Map, so non-string keys keep their type (`pins: {4: a}`). */
export function parseYamlMaps(text: string): ParsedCatalog {
  return parseYaml11(text, true);
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** Python truthiness, for the CLI's `x or default`. */
const isFalsy = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === false ||
  v === 0 ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (isMapping(v) && Object.keys(v).length === 0);

function describe(value: unknown): string {
  if (value === null) return "empty";
  if (value instanceof Date) return `a date (${value.toISOString()})`;
  if (Array.isArray(value)) return "a list";
  if (isMapping(value)) return "a mapping";
  return `a ${typeof value} (${String(value)})`;
}

function readEntry(raw: Record<string, unknown>, type: EntryType, path: string, catalog: string) {
  const problems: EntryProblem[] = [];
  const text = (field: "name" | "description" | "source") => {
    const value = field in raw ? raw[field] : "";
    if (typeof value === "string") return value;
    problems.push({ kind: "field", path: `${path}.${field}`, field, value, message: `${path}.${field} is ${describe(value)}, not text; quote it` });
    return "";
  };
  const name = text("name");
  const description = text("description");
  const source = text("source");
  const value = raw.requires;
  let requires: string[] = [];
  if (!isFalsy(value)) {
    if (Array.isArray(value) && value.every((r) => typeof r === "string")) requires = value;
    else {
      const message = `${path}.requires is ${describe(value)}, not a list of type:name refs`;
      problems.push({ kind: "field", path: `${path}.requires`, field: "requires", value, message });
    }
  }
  const entry: Entry = { type, name, description, source, requires, catalog };
  return { entry: problems.length === 0 ? entry : undefined, problems };
}

/** Entries in section order skills, agents, prompts (RES-02); bad items are skipped and reported. */
export function catalogEntries(data: unknown, catalog: string): { entries: Entry[]; problems: EntryProblem[] } {
  const entries: Entry[] = [];
  const problems: EntryProblem[] = [];
  if (isFalsy(data)) return { entries, problems };
  if (!isMapping(data)) return { entries, problems: [{ kind: "structure", path: "", message: "the catalog is not a mapping" }] };
  const library = isFalsy(data.library) ? {} : data.library;
  if (!isMapping(library)) {
    return { entries, problems: [{ kind: "structure", path: "library", message: "'library:' is not a mapping" }] };
  }
  for (const [type, section] of SECTIONS) {
    const items = library[section];
    if (isFalsy(items)) continue;
    if (!Array.isArray(items)) {
      problems.push({ kind: "structure", path: section, message: `'${section}:' is not a list` });
      continue;
    }
    items.forEach((raw: unknown, i) => {
      const path = `${section}[${i}]`;
      if (!isMapping(raw)) {
        problems.push({ kind: "structure", path, message: `${path} is not a mapping with name, description and source` });
        return;
      }
      const read = readEntry(raw, type, path, catalog);
      if (read.entry) entries.push(read.entry);
      problems.push(...read.problems);
    });
  }
  return { entries, problems };
}

/** WRITE-16: before writing, the edited text must parse and hold the entry (add, update) or not (remove). */
export function verifyEdit(text: string, entry: { type: EntryType; name: string }, present: boolean): void {
  const abort = (why: string): never => {
    throw new LibraryError("VERIFY_FAILED", `internal error: ${why}; aborting`);
  };
  const parsed = parseCatalog(text);
  if (!parsed.ok) abort(`the edited catalog does not parse (${parsed.problem.message})`);
  const section = SECTIONS.find(([t]) => t === entry.type)![1];
  const { entries } = catalogEntries(parsed.ok && parsed.data, "");
  const found = entries.some((e) => e.type === entry.type && e.name === entry.name);
  if (found !== present) abort(`'${entry.name}' is ${present ? "missing from" : "still in"} ${section} after the edit`);
}

/** EDIT-14 (doctor): `<section> not alphabetically sorted` unless names follow Python's sorted(key=str.lower). */
export function sortedProblems(entries: Entry[]): string[] {
  return SECTIONS.flatMap(([type, section]) => {
    const names = entries.filter((e) => e.type === type).map((e) => e.name);
    const sorted = [...names].sort((a, b) => {
      const [x, y] = [a.toLowerCase(), b.toLowerCase()];
      return pyLess(x, y) ? -1 : pyLess(y, x) ? 1 : 0;
    });
    return names.some((n, i) => n !== sorted[i]) ? [`${section} not alphabetically sorted`] : [];
  });
}
