// Python string semantics the CLI's behavior depends on.

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
