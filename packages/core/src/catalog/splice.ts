// Line-based catalog edits, ported from library.py's splice functions (behaviors.md §2.7) with the
// rebuild's decisions applied (§0.1, tools/golden/rebuild_ref.py).
import { LibraryError, type Entry, type EntryType } from "../model/model.ts";
import { pyyamlInline } from "./scalar.ts";

const ENTRY_TYPES = ["skill", "agent", "prompt"];
const PLURAL: Record<EntryType, string> = { skill: "skills", agent: "agents", prompt: "prompts" };

// Python's str.isspace() set, which its regex `\s` and str.strip() use; JS's `\s` and trim() differ.
const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LIBRARY_RE = new RegExp(`^library:[${WS}]*$`);
const TOP_LEVEL_RE = new RegExp(`^[^${WS}]`);
const SIBLING_RE = new RegExp(`^  [^${WS}]`);
// `s`: Python's `.` matches `\r`, which CRLF files leave at the end of every line.
const ITEM_NAME_RE = new RegExp(`^    - name:[${WS}]*(.+?)[${WS}]*$`, "s");
const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const LSTRIP_RE = new RegExp(`^[${WS}]+`);

const strip = (s: string) => s.replace(STRIP_RE, "");
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

/** Python's `a < b` on strings: by code point, not by UTF-16 unit. */
function pyLess(a: string, b: string): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0;
  }
  return x.length < y.length;
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

/** Throws SPLICE_UNSUPPORTED unless the type's section can be edited line by line. */
export function assertSpliceable(text: string, type: EntryType): void {
  const lines = text.split("\n");
  checkLayout(lines, locateSection(lines, PLURAL[type]));
}

/** EDIT-07: items start with exactly four spaces and `- name:`; quotes around the name are dropped. */
function itemsOf(lines: string[], { idx, end }: Section): { name: string; line: number }[] {
  const items = [];
  for (let i = idx + 1; i < end; i++) {
    const m = lines[i]!.startsWith("    - ") ? ITEM_NAME_RE.exec(lines[i]!) : null;
    if (m) items.push({ name: strip(m[1]!).replace(/^["']+|["']+$/g, ""), line: i });
  }
  return items;
}

/** EDIT-08: insert in case-insensitive name order without re-sorting; `[]` becomes a block list. */
export function spliceEntry(text: string, entry: Omit<Entry, "catalog">): string {
  const section = PLURAL[entry.type];
  const lines = text.split("\n");
  const block = renderEntry(entry);
  const sec = locateSection(lines, section);
  checkLayout(lines, sec);
  const items = itemsOf(lines, sec);
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
