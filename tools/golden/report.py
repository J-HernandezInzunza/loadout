#!/usr/bin/env python3
"""Render the splice cases where the rebuild deviates from library.py as one HTML page.

  python3 tools/golden/report.py [out.html]

Reads packages/core/test/golden/splice.json; stdlib only. Each distinct diff appears once, with
every case id that produces it, grouped by the rule behind the deviation (behaviors.md §0.1).
"""

from __future__ import annotations

import difflib
import html
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "packages/core/test/golden/splice.json"

RULES = [
    ("D1", "Missing sections are created",
     "library.py refuses to insert into a section the catalog doesn't have. Loadout adds the section in "
     "canonical order (skills, agents, prompts). Shown: what Loadout writes, as a diff of the input."),
    ("D2", "Unsupported layouts are refused up front",
     "library.py splices these layouts into invalid YAML, which its write path then rejects. Loadout "
     "refuses before writing, naming the line. Shown: what library.py would have produced."),
    ("D3", "Remove keeps blank lines and comments",
     "Shown: library.py's output (−) against Loadout's (+)."),
    ("D4", "Update edits in place",
     "Shown: library.py's output (−) against Loadout's (+)."),
    ("A11", "Unsafe requires refs are refused", "library.py writes the ref unescaped. Loadout refuses it."),
]


def classify(case: dict) -> str:
    py, rb = case["python"], case["rebuild"]
    kinds = {op["op"] for op in case["ops"]}
    if "render" in kinds or rb.get("error", {}).get("code") == "INVALID_REF":
        return "A11"
    if rb.get("error", {}).get("code") == "SPLICE_UNSUPPORTED":
        return "D2"
    if "error" in py and "not found under library" in py["error"]["message"]:
        return "D1"
    return "D4" if "replace" in kinds else "D3"


def diff(a: str, b: str) -> list[tuple[str, str]]:
    rows = []
    for line in list(difflib.unified_diff(a.split("\n"), b.split("\n"), lineterm="", n=2))[2:]:
        kind = {"+": "add", "-": "del", "@": "hunk"}.get(line[:1], "ctx")
        rows.append((kind, line))
    return rows


def show(text: str) -> str:
    return html.escape(text.replace("\r", "␍").replace("\t", "⇥"))


def block(case: dict, texts: dict) -> str:
    py, rb = case["python"], case["rebuild"]
    source = texts[case["text"]]["text"] if case["text"] else ""
    parts = []
    if "error" in py:
        parts.append(f'<p class="verdict"><span class="who py">library.py</span> {show(py["error"]["message"])}</p>')
    if "error" in rb:
        line = f' (line {rb["error"]["line"]})' if "line" in rb["error"] else ""
        parts.append(f'<p class="verdict"><span class="who rb">Loadout</span> <code>{rb["error"]["code"]}</code>{line}: '
                     f'{show(rb["error"]["message"])}</p>')
    if "lines" in py:
        rows = [("del", "  " + l) for l in py["lines"]]
    elif "text" in py and "text" in rb:
        rows = diff(py["text"], rb["text"])
    elif "text" in rb:
        rows = diff(source, rb["text"])
    elif "text" in py:
        rows = diff(source, py["text"])
        if py.get("yamlValid") is False:
            parts.append('<p class="note">library.py output below is invalid YAML.</p>')
    else:
        rows = []
    if rows:
        body = "\n".join(f'<span class="{k}">{show(t) or " "}</span>' for k, t in rows)
        parts.append(f'<div class="code"><pre>{body}</pre></div>')
    return "\n".join(parts)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "node_modules/.cache/loadout/deviations.html"
    data = json.loads(FIXTURE.read_text())
    texts, cases = data["texts"], [c for c in data["cases"] if "rebuild" in c]
    groups: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for c in cases:
        groups[classify(c)][block(c, texts)].append(c["id"])

    total_distinct = sum(len(g) for g in groups.values())
    nav = "".join(
        f'<a href="#{rid}"><b>{rid}</b> {html.escape(title)} <span class="n">{sum(len(v) for v in groups[rid].values())}</span></a>'
        for rid, title, _ in RULES if rid in groups)
    sections = []
    for rid, title, blurb in RULES:
        if rid not in groups:
            continue
        items = []
        for i, (body, ids) in enumerate(sorted(groups[rid].items(), key=lambda kv: (-len(kv[1]), kv[1][0])), 1):
            id_list = "".join(f"<li><code>{html.escape(x)}</code></li>" for x in ids)
            items.append(f"""
<article class="dev">
  <header><span class="idx">{rid}.{i}</span><span class="count">{len(ids)} case{'s' if len(ids) > 1 else ''}</span></header>
  {body}
  <details><summary>Case ids</summary><ul>{id_list}</ul></details>
</article>""")
        n = sum(len(v) for v in groups[rid].values())
        sections.append(f"""
<section id="{rid}">
  <h2><span class="rule">{rid}</span> {html.escape(title)}</h2>
  <p class="meta">{n} cases, {len(groups[rid])} distinct diffs. {html.escape(blurb)}</p>
  {''.join(items)}
</section>""")

    page = TEMPLATE.format(
        total=len(cases), all_cases=len(data["cases"]), distinct=total_distinct,
        commit=data["meta"]["library"]["commit"], nav=nav, sections="".join(sections))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    print(out)


TEMPLATE = """<title>Loadout Splice Deviations</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Sans+Condensed:wght@600&display=swap">
<style>
/* Layout: one reading column of review cards, rule nav up top; diffs scroll inside their own box. */
:root {{
  --bg: #f6f7f5; --surface: #ffffff; --fg: #1d2420; --muted: #5d6862; --line: #dde2de;
  --accent: #2f6b4f; --add-bg: #e3f3e8; --add-fg: #135c32; --del-bg: #fbe7e5; --del-fg: #8c2a20;
  --hunk: #6a5b9a; --code-bg: #fafbfa;
  --display: "IBM Plex Sans Condensed", "Arial Narrow", sans-serif;
  --body: "IBM Plex Sans", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg: #121614; --surface: #1a201d; --fg: #e3e8e4; --muted: #96a29b; --line: #2c3530;
  --accent: #7cc4a0; --add-bg: #173323; --add-fg: #8fdcae; --del-bg: #3a1d1a; --del-fg: #f2a196;
  --hunk: #b3a5e6; --code-bg: #151a17; color-scheme: dark; }} }}
:root[data-theme="dark"] {{
  --bg: #121614; --surface: #1a201d; --fg: #e3e8e4; --muted: #96a29b; --line: #2c3530;
  --accent: #7cc4a0; --add-bg: #173323; --add-fg: #8fdcae; --del-bg: #3a1d1a; --del-fg: #f2a196;
  --hunk: #b3a5e6; --code-bg: #151a17; color-scheme: dark; }}
body {{ background: var(--bg); color: var(--fg); font: 15px/1.55 var(--body); }}
.wrap {{ max-width: 920px; margin: 0 auto; padding-block: 32px 64px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: grid; gap: 28px; }}
h1, h2 {{ font-family: var(--display); font-weight: 600; text-wrap: balance; margin: 0; letter-spacing: .01em; }}
h1 {{ font-size: 2rem; line-height: 1.15; }}
h2 {{ font-size: 1.35rem; display: flex; gap: 10px; align-items: baseline; }}
.lede {{ max-width: 65ch; margin: 8px 0 0; color: var(--muted); }}
.lede strong {{ color: var(--fg); }}
.stats {{ display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 14px; font-variant-numeric: tabular-nums; color: var(--muted); font-size: .9rem; }}
.stats b {{ color: var(--fg); font-size: 1.05rem; }}
nav {{ display: flex; flex-wrap: wrap; gap: 8px; }}
nav a {{ text-decoration: none; color: var(--fg); background: var(--surface); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 10px; font-size: .9rem; display: inline-flex; gap: 6px; align-items: baseline; }}
nav a:hover, nav a:focus-visible {{ border-color: var(--accent); outline: none; }}
nav b, .rule {{ font-family: var(--mono); color: var(--accent); }}
.n {{ color: var(--muted); font-variant-numeric: tabular-nums; }}
section {{ display: grid; gap: 14px; scroll-margin-top: 16px; }}
.meta {{ margin: 0; color: var(--muted); max-width: 65ch; }}
.dev {{ background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px;
  display: grid; gap: 10px; min-width: 0; }}
.dev header {{ display: flex; justify-content: space-between; font-family: var(--mono); font-size: .8rem; color: var(--muted); }}
.idx {{ color: var(--accent); font-weight: 600; }}
.verdict {{ margin: 0; font-size: .92rem; }}
.verdict code, li code {{ font-family: var(--mono); font-size: .85em; }}
.who {{ font-family: var(--mono); font-size: .75rem; text-transform: uppercase; letter-spacing: .06em;
  padding: 1px 6px; border-radius: 4px; margin-right: 6px; }}
.who.py {{ background: var(--del-bg); color: var(--del-fg); }}
.who.rb {{ background: var(--add-bg); color: var(--add-fg); }}
.note {{ margin: 0; font-size: .85rem; color: var(--del-fg); }}
.code {{ overflow-x: auto; background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; }}
pre {{ margin: 0; padding: 8px 0; font: 12.5px/1.5 var(--mono); }}
pre span {{ display: block; padding: 0 12px; white-space: pre; }}
.add {{ background: var(--add-bg); color: var(--add-fg); }}
.del {{ background: var(--del-bg); color: var(--del-fg); }}
.hunk {{ color: var(--hunk); }}
details summary {{ cursor: pointer; color: var(--muted); font-size: .85rem; }}
details summary:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
details ul {{ margin: 6px 0 0; padding-left: 18px; columns: 2 280px; font-size: .82rem; color: var(--muted); }}
@media (prefers-reduced-motion: no-preference) {{ html {{ scroll-behavior: smooth; }} }}
</style>
<div class="wrap">
  <header>
    <h1>Splice deviations from library.py</h1>
    <p class="lede">Every golden splice case where Loadout will write something different from the Python CLI,
      because of your answers to Q4, A11, A12 and A13. <strong>Review question for each card: is the Loadout
      result what you want the app to write?</strong> Red is what <code>library.py</code> does, green is what Loadout does.</p>
    <div class="stats"><span><b>{total}</b> of {all_cases} cases deviate</span><span><b>{distinct}</b> distinct diffs</span>
      <span>library.py @ <b>{commit}</b></span></div>
  </header>
  <nav aria-label="Rules">{nav}</nav>
  {sections}
</div>
"""

if __name__ == "__main__":
    main()
