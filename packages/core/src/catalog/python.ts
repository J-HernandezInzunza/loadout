// Python string semantics the CLI's behavior depends on.

// Python's str.isspace() set, which its regex `\s` and str.strip() use; JS's `\s` and trim() differ.
export const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

/** Python's str.strip() with no arguments. */
export const strip = (s: string) => s.replace(STRIP_RE, "");

/** Python's `a < b` on strings: by code point, not by UTF-16 unit. */
export function pyLess(a: string, b: string): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0;
  }
  return x.length < y.length;
}
