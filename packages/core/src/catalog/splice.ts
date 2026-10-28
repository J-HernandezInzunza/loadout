// Line-based catalog edits, ported from library.py's splice functions (behaviors.md §2.7) with the
// rebuild's decisions applied (§0.1, tools/golden/rebuild_ref.py).
import { LibraryError, type Entry, type EntryType } from "../model/model.ts";
import { pyLess, strip, WS } from "./python.ts";
import { pyyamlInline } from "./scalar.ts";

const ENTRY_TYPES = ["skill", "agent", "prompt"];
const PLURAL: Record<EntryType, string> = { skill: "skills", agent: "agents", prompt: "prompts" };
const SECTIONS = ["skills", "agents", "prompts"];

const LIBRARY_RE = new RegExp(`^library:[${WS}]*$`);
const TOP_LEVEL_RE = new RegExp(`^[^${WS}]`);
const SIBLING_RE = new RegExp(`^  [^${WS}]`);
// `s`: Python's `.` matches `\r`, which CRLF files leave at the end of every line.
const ITEM_NAME_RE = new RegExp(`^    - name:[${WS}]*(.+?)[${WS}]*$`, "s");
const KEY_RE = /^ {6}([A-Za-z_][A-Za-z0-9_-]*):/;
const LSTRIP_RE = new RegExp(`^[${WS}]+`);

const isBlank = (line: string) => strip(line) === "";

// A11: refs are written inside `"` without escaping, so these would break the YAML.
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const BAD_REF = /["\\\x00-\x1f\x7f]/;

/** Python's repr() of a str, which the CLI's messages use to show a ref. */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = Array.from(s, (ch) => {
    if (ch === "\\" || ch === quote) return "\\" + ch;
    if (ch === "\t") return "\\t";
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === " " || !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}]/u.test(ch)) return ch;
    const c = ch.codePointAt(0)!;
    if (c <= 0xff) return "\\x" + c.toString(16).padStart(2, "0");
    if (c <= 0xffff) return "\\u" + c.toString(16).padStart(4, "0");
    return "\\U" + c.toString(16).padStart(8, "0");
  });
  return quote + body.join("") + quote;
}

function refuseBadChars(ref: string): void {
  if (BAD_REF.test(ref)) throw new LibraryError("INVALID_REF", `invalid requires ref ${pyRepr(ref)}`);
}

/** DEP-11 for authoring input: `type:name` with a known type, and no character A11 refuses. */
export function validateRef(ref: string): void {
  refuseBadChars(ref);
  const colon = ref.indexOf(":");
  const type = ref.slice(0, colon).trim();
  const name = ref.slice(colon + 1).trim();
  if (colon < 0 || !ENTRY_TYPES.includes(type) || name === "") {
    throw new LibraryError("INVALID_REF", `invalid requires ref '${ref}' (expected type:name)`);
  }
}

/** EDIT-01: a 4-space item with 6-space props; `requires` as a flow list only when non-empty. */
export function renderEntry(entry: Omit<Entry, "catalog">): string[] {
  entry.requires.forEach(refuseBadChars);
  const lines = [
    `    - name: ${pyyamlInline(entry.name)}`,
    `      description: ${pyyamlInline(entry.description)}`,
    `      source: ${pyyamlInline(entry.source)}`,
  ];
  if (entry.requires.length > 0) lines.push(`      requires: [${entry.requires.map((r) => `"${r}"`).join(", ")}]`);
  return lines;
}

interface Section {
  /** the header line */
  idx: number;
  /** what follows `<section>:` on the header, stripped */
  inline: string;
  /** first line after the section (exclusive) */
  end: number;
}

function libraryIdx(lines: string[]): number {
  const idx = lines.findIndex((l) => LIBRARY_RE.test(l));
  if (idx < 0) throw new LibraryError("SPLICE_UNSUPPORTED", "no 'library:' key in catalog");
  return idx;
}

/** EDIT-04, EDIT-06: the header is `  <section>:` inside the library block; it ends at the next key. */
function findSection(lines: string[], section: string): Section | undefined {
  const header = new RegExp(`^  ${section}:[${WS}]*(.*)$`, "s");
  for (let i = libraryIdx(lines) + 1; i < lines.length; i++) {
    if (TOP_LEVEL_RE.test(lines[i]!)) break;
    const m = header.exec(lines[i]!);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (TOP_LEVEL_RE.test(l) || (SIBLING_RE.test(l) && !l.startsWith("    "))) {
        end = j;
        break;
      }
    }
    return { idx: i, inline: strip(m[1]!), end };
  }
  return undefined;
}

function locateSection(lines: string[], section: string): Section {
  const found = findSection(lines, section);
  if (!found) throw new LibraryError("SPLICE_UNSUPPORTED", `section '${section}' not found under library`);
  return found;
}

const indent = (line: string) => line.length - line.replace(/^ +/, "").length;
const lstrip = (s: string) => s.replace(LSTRIP_RE, "");

/** D2 (EDIT-09): refuse, before any edit, a section the line-based splice would turn into invalid YAML. */
function checkLayout(lines: string[], { idx, inline, end }: Section): void {
  const refuse = (i: number, why: string): never => {
    throw new LibraryError("SPLICE_UNSUPPORTED", `line ${i + 1}: ${why}`, i + 1);
  };
  if (inline !== "" && inline !== "[]" && !inline.startsWith("#")) {
    refuse(idx, `section value ${pyRepr(inline)} is not a block list or []`);
  }
  let seenItem = false;
  for (let i = idx + 1; i < end; i++) {
    const l = lines[i]!.replace(/\r+$/, "");
    if (isBlank(l) || lstrip(l).startsWith("#")) continue;
    if (l.startsWith("    - ")) {
      if (!ITEM_NAME_RE.test(l)) refuse(i, "an entry must start with '- name:'");
      seenItem = true;
    } else if (!(indent(l) >= 6 && seenItem)) {
      refuse(i, "entries must be indented four spaces with fields at six");
    }
  }
  if (end < lines.length && lstrip(lines[end]!).startsWith("-")) {
    refuse(end, "entries must be indented four spaces with fields at six");
  }
}

/** EDIT-07: items start with exactly four spaces and `- name:`; quotes around the name are dropped. */
function itemsOf(lines: string[], { idx, end }: Section): Item[] {
  const items: Item[] = [];
  for (let i = idx + 1; i < end; i++) {
    const m = lines[i]!.startsWith("    - ") ? ITEM_NAME_RE.exec(lines[i]!) : null;
    if (m) items.push({ name: strip(m[1]!).replace(/^["']+|["']+$/g, ""), line: i });
  }
  return items;
}

type Item = { name: string; line: number };

function prepare(lines: string[], section: string): { sec: Section; items: Item[] } {
  const sec = locateSection(lines, section);
  checkLayout(lines, sec);
  return { sec, items: itemsOf(lines, sec) };
}

/**
 * D1 (EDIT-05): add the missing section after the nearest earlier one in canonical order, placed by
 * the append rule, or right after `library:` when none precedes it.
 */
function insertSection(lines: string[], section: string, block: string[]): string {
  const earlier = SECTIONS.slice(0, SECTIONS.indexOf(section))
    .map((s) => findSection(lines, s))
    .filter((s) => s !== undefined);
  const prev = earlier.at(-1);
  let at = libraryIdx(lines) + 1;
  if (prev) {
    checkLayout(lines, prev); // its end only means something if the splice could edit it
    at = prev.end;
    while (at - 1 > prev.idx && isBlank(lines[at - 1]!)) at--;
  }
  lines.splice(at, 0, `  ${section}:`, ...block);
  return lines.join("\n");
}

/** EDIT-08: insert in case-insensitive name order without re-sorting; `[]` becomes a block list. */
export function spliceEntry(text: string, entry: Omit<Entry, "catalog">): string {
  const section = PLURAL[entry.type];
  const lines = text.split("\n");
  const block = renderEntry(entry);
  if (!findSection(lines, section)) return insertSection(lines, section, block);
  const { sec, items } = prepare(lines, section);
  if (items.some((i) => i.name === entry.name)) {
    throw new LibraryError("DUPLICATE", `'${entry.name}' already exists in ${section}`);
  }
  if (sec.inline === "[]") {
    lines[sec.idx] = `  ${section}:`;
    lines.splice(sec.idx + 1, 0, ...block);
    return lines.join("\n");
  }
  let at = items.find((i) => pyLess(entry.name.toLowerCase(), i.name.toLowerCase()))?.line ?? sec.end;
  if (at === sec.end) {
    // Appending: stay above the blank lines that separate this section from the next.
    while (at - 1 > sec.idx && isBlank(lines[at - 1]!)) at--;
  }
  lines.splice(at, 0, ...block);
  return lines.join("\n");
}

/** Index of the item's last own line: lines indented six or more, blanks only between them (D3). */
function ownEnd(lines: string[], target: number, limit: number): number {
  let last = target;
  for (let j = target + 1; j < limit; j++) {
    if (isBlank(lines[j]!)) continue;
    if (indent(lines[j]!) < 6) break;
    last = j;
  }
  return last;
}

/** The named item's line and the line where the next item (or the section) starts. */
function target(items: Item[], name: string, section: string, sec: Section): { line: number; limit: number } {
  const k = items.findIndex((i) => i.name === name);
  if (k < 0) throw new LibraryError("NOT_FOUND", `'${name}' not found in ${section}`);
  return { line: items[k]!.line, limit: items[k + 1]?.line ?? sec.end };
}

/**
 * D3 (EDIT-10, EDIT-11): delete the item's own lines plus the blank lines after them, or, for the
 * last item, the blank lines above it, so the separator before the next section stays. Comments
 * indented under six spaces are never deleted; an emptied section becomes `[]`.
 */
export function removeEntry(text: string, type: EntryType, name: string): string {
  const section = PLURAL[type];
  const lines = text.split("\n");
  const { sec, items } = prepare(lines, section);
  const { line, limit } = target(items, name, section, sec);
  let start = line;
  let stop = ownEnd(lines, line, limit) + 1;
  if (line === items.at(-1)!.line) {
    while (start - 1 > sec.idx && isBlank(lines[start - 1]!)) start--;
  } else {
    while (stop < limit && isBlank(lines[stop]!)) stop++;
  }
  lines.splice(start, stop - start);
  if (items.length === 1) lines[sec.idx] = `  ${section}: []`;
  return lines.join("\n");
}

/** Exclusive end of a key's value: deeper lines, or a same-indent `- ` block sequence. */
function valueEnd(lines: string[], keyIdx: number, own: number): number {
  let j = keyIdx + 1;
  while (j <= own) {
    const l = lines[j]!;
    if (!(isBlank(l) || indent(l) > 6 || (indent(l) === 6 && l.slice(6).startsWith("-")))) break;
    j++;
  }
  while (j - 1 > keyIdx && isBlank(lines[j - 1]!)) j--; // trailing blanks belong to nobody
  return j;
}

const FIELDS = ["description", "source", "requires"] as const;

/**
 * D4 (EDIT-12): rewrite description, source and requires in place within the item's own lines,
 * inserting a missing one after the nearest earlier field; the name line, every other key, comments
 * and blank lines stay byte for byte.
 */
export function replaceEntry(text: string, type: EntryType, name: string, entry: Omit<Entry, "catalog">): string {
  const section = PLURAL[type];
  const lines = text.split("\n");
  const { sec, items } = prepare(lines, section);
  const { line } = target(items, name, section, sec);
  const rendered = renderEntry(entry);
  const want = { description: rendered[1]!, source: rendered[2]!, requires: rendered[3] };

  // Re-located after every edit: edits above change where the item ends.
  const keys = () => {
    const s = locateSection(lines, section);
    const { limit } = target(itemsOf(lines, s), name, section, s);
    const own = ownEnd(lines, line, limit);
    const found = new Map<string, [number, number]>();
    for (let i = line + 1; i <= own; i++) {
      const key = KEY_RE.exec(lines[i]!)?.[1];
      if (key !== undefined && !found.has(key)) found.set(key, [i, valueEnd(lines, i, own)]);
    }
    return found;
  };

  FIELDS.forEach((key, k) => {
    const value = want[key];
    const found = keys().get(key);
    if (found) {
      lines.splice(found[0], found[1] - found[0], ...(value === undefined ? [] : [value]));
      return;
    }
    if (value === undefined) return;
    const current = keys();
    let at = line + 1;
    for (const prev of FIELDS.slice(0, k)) {
      const p = current.get(prev);
      if (p) at = p[1];
    }
    lines.splice(at, 0, value);
  });
  return lines.join("\n");
}
