// Line-based catalog edits, ported from library.py's splice functions (behaviors.md §2.7) with the
// rebuild's decisions applied (§0.1, tools/golden/rebuild_ref.py).
import { LibraryError, type Entry } from "../model/model.ts";
import { pyyamlInline } from "./scalar.ts";

const ENTRY_TYPES = ["skill", "agent", "prompt"];

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
