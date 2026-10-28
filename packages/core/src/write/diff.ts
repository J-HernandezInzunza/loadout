// A unified diff of two texts (WRITE-17's dry run), in difflib.unified_diff's shape: `--- a/<file>`,
// `+++ b/<file>`, hunks with three lines of context and difflib's range format. Line-based LCS is
// plenty for catalog files, which run to hundreds of lines, not thousands.

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

function lines(text: string): string[] {
  const out = text.split(/(?<=\n)/);
  return out.length === 1 && out[0] === "" ? [] : out;
}

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ kind: " ", line: a[i]!, a: i++, b: j++ });
    // On a tie, deletions first, as difflib orders a replaced block.
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: "-", line: a[i]!, a: i++, b: j });
    else out.push({ kind: "+", line: b[j]!, a: i, b: j++ });
  }
  return out;
}

/** difflib's _format_range_unified. */
function range(start: number, length: number): string {
  if (length === 1) return `${start + 1}`;
  return `${length === 0 ? start : start + 1},${length}`;
}

export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  const all = ops(lines(before), lines(after));
  const changed = all.map((o, k) => (o.kind === " " ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return "";

  // Group changes whose context windows touch into one hunk.
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(all.length - 1, k + context);
    const last = hunks.at(-1);
    if (last && lo <= last[1] + 1) last[1] = hi;
    else hunks.push([lo, hi]);
  }

  const nl = (s: string) => (s.endsWith("\n") ? s : s + "\n");
  let out = `--- a/${file}\n+++ b/${file}\n`;
  for (const [lo, hi] of hunks) {
    const span = all.slice(lo, hi + 1);
    const aLen = span.filter((o) => o.kind !== "+").length;
    const bLen = span.filter((o) => o.kind !== "-").length;
    out += `@@ -${range(span[0]!.a, aLen)} +${range(span[0]!.b, bLen)} @@\n`;
    for (const o of span) out += o.kind + nl(o.line);
  }
  return out;
}
