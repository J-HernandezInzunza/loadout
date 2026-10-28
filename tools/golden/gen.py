#!/usr/bin/env python3
"""Regenerate the golden fixtures from the old CLI's library.py (architecture.md §3.2). Dev-only.

Run with the old repo's venv (PyYAML 6.0.3), through npm:
  npm run golden          write packages/core/test/golden/*.json
  npm run golden:check    regenerate into a temp dir and diff against the committed fixtures

library.py is imported read-only (no bytecode written) from LIBRARY_SKILL_DIR, which defaults to
~/Projects/my-tools/the-library-skill and must be at commit a29e816 with library.py unmodified.
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import rebuild_ref  # noqa: E402
from texts import TEXTS  # noqa: E402

REPO = HERE.parent.parent
OUT_DIR = REPO / "packages" / "core" / "test" / "golden"
EXPECTED_COMMIT = "a29e816"
SEED = 20261028
FAKE_HOME = "/home/golden"  # parse_source expands '~' against $HOME


def load_library(old_repo: Path, allow_any_commit: bool) -> Any:
    commit = subprocess.run(["git", "-C", str(old_repo), "rev-parse", "--short=7", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(old_repo), "status", "--porcelain", "--", "library.py"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if not allow_any_commit and (commit != EXPECTED_COMMIT or dirty):
        sys.exit(f"{old_repo} is at {commit}{' with library.py modified' if dirty else ''}; "
                 f"the fixtures are pinned to {EXPECTED_COMMIT}")
    os.environ["HOME"] = FAKE_HOME
    spec = importlib.util.spec_from_file_location("library", old_repo / "library.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["library"] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    module.GOLDEN_COMMIT = commit
    return module


def meta(lib: Any, corpus: str, **extra: Any) -> dict[str, Any]:
    import yaml
    return {
        "corpus": corpus,
        "generator": "tools/golden/gen.py",
        "library": {"repo": "the-library-skill", "commit": lib.GOLDEN_COMMIT},
        "python": ".".join(map(str, sys.version_info[:3])),
        "pyyaml": yaml.__version__,
        **extra,
    }


# --------------------------------------------------------------------------------------------
# splice corpus
# --------------------------------------------------------------------------------------------

SECTIONS = ("skills", "agents", "prompts")
SINGULAR = {"skills": "skill", "agents": "agent", "prompts": "prompt"}


def entry_json(etype: str, name: str, *, requires: list[str] | None = None, tag: str = "") -> dict[str, Any]:
    leaf = f"{name}/SKILL.md" if etype == "skill" else f"{name}.md"
    return {
        "type": etype,
        "name": name,
        "description": f"Golden {etype} {name}{tag}",
        "source": f"https://github.com/acme/agentics/blob/main/{etype}s/{leaf}",
        "requires": requires or [],
    }


def section_names(lib: Any, text: str, section: str) -> list[str] | None:
    lines = text.split("\n")
    try:
        sec_idx, _, sec_end = lib._locate_section(lines, section)
    except lib.LibraryError:
        return None
    return [m.group(1).strip().strip("\"'")
            for i in lib._item_starts(lines, sec_idx, sec_end)
            if (m := lib._ITEM_NAME_RE.match(lines[i]))]


def op_scripts(lib: Any, text: str) -> list[tuple[str, list[dict[str, Any]]]]:
    """Every operation worth checking against one catalog text, as (label, ops)."""
    scripts: list[tuple[str, list[dict[str, Any]]]] = []
    for section in SECTIONS:
        t = SINGULAR[section]
        names = section_names(lib, text, section)
        add = lambda name, **kw: {"op": "splice", "entry": entry_json(t, name, **kw)}  # noqa: E731
        scripts.append((f"{section}/insert-first", [add("aaa-first")]))
        scripts.append((f"{section}/insert-last", [add("zzz-last", requires=["skill:alpha"])]))
        scripts.append((f"{section}/insert-batch", [add("zzz-b"), add("aaa-b"), add("mmm-b")]))
        scripts.append((f"{section}/round-trip-last", [add("zzz-last"), {"op": "remove", "type": t, "name": "zzz-last"}]))
        scripts.append((f"{section}/round-trip-first", [add("aaa-first"), {"op": "remove", "type": t, "name": "aaa-first"}]))
        scripts.append((f"{section}/remove-unknown", [{"op": "remove", "type": t, "name": "no-such-entry"}]))
        scripts.append((f"{section}/replace-unknown",
                        [{"op": "replace", "type": t, "name": "no-such-entry", "entry": entry_json(t, "no-such-entry")}]))
        for k, name in enumerate(names or []):
            scripts.append((f"{section}/{k}:{name}/insert-duplicate", [add(name)]))
            scripts.append((f"{section}/{k}:{name}/insert-other-case", [add(name.upper() if name != name.upper() else name.lower())]))
            scripts.append((f"{section}/{k}:{name}/insert-after", [add(name + "-after")]))
            scripts.append((f"{section}/{k}:{name}/remove", [{"op": "remove", "type": t, "name": name}]))
            scripts.append((f"{section}/{k}:{name}/replace", [{"op": "replace", "type": t, "name": name,
                                                                "entry": entry_json(t, name, tag=" (edited)")}]))
            scripts.append((f"{section}/{k}:{name}/replace-with-requires",
                            [{"op": "replace", "type": t, "name": name,
                              "entry": entry_json(t, name, requires=["skill:alpha", "prompt:solo"])}]))
        if names:
            scripts.append((f"{section}/remove-all", [{"op": "remove", "type": t, "name": n} for n in dict.fromkeys(names)]))
    return scripts


RENDER_CASES: list[tuple[str, dict[str, Any]]] = [
    ("render/plain", entry_json("skill", "thing")),
    ("render/requires", entry_json("skill", "thing", requires=["skill:alpha", "prompt:solo"])),
    ("render/quoted-description", {**entry_json("skill", "thing"), "description": "Fixes: things"}),
    ("render/name-needs-quotes", {**entry_json("skill", "yes"), "name": "yes"}),
    ("render/multiline-description", {**entry_json("skill", "thing"), "description": "line one\nline two"}),
    ("render/requires-with-quote", entry_json("skill", "thing", requires=['skill:a"b'])),
    ("render/requires-with-backslash", entry_json("skill", "thing", requires=["skill:a\\b"])),
    ("render/requires-with-tab", entry_json("skill", "thing", requires=["skill:a\tb"])),
]


def run_ops(text: str, ops: list[dict[str, Any]], impl: Any, entry_cls: Any,
            error_types: tuple[type, ...], encode_error: Callable[[Exception], dict[str, Any]]) -> dict[str, Any]:
    import yaml
    try:
        for op in ops:
            e = op.get("entry")
            entry = entry_cls(e["type"], e["name"], e["description"], e["source"], list(e["requires"])) if e else None
            if op["op"] == "render":
                return {"lines": impl.render_entry(entry)}
            if op["op"] == "splice":
                text = impl.splice_entry(text, entry)
            elif op["op"] == "remove":
                text = impl.remove_entry(text, op["type"], op["name"])
            else:
                text = impl.replace_entry(text, op["type"], op["name"], entry)
    except error_types as ex:
        return {"error": encode_error(ex)}
    try:
        yaml.safe_load(text)
        valid = True
    except yaml.YAMLError:
        valid = False
    return {"text": text, "yamlValid": valid}


def splice_corpus(lib: Any, old_repo: Path) -> dict[str, Any]:
    texts = {k: v for k, v in TEXTS.items()}
    texts["example"] = ("library.example.yaml", (old_repo / "library.example.yaml").read_text())

    def py(text: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
        return run_ops(text, ops, lib, lib.Entry, (lib.LibraryError,), lambda ex: {"message": str(ex)})

    def rb(text: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
        result = run_ops(text, ops, rebuild_ref, rebuild_ref.Entry, (rebuild_ref.SpliceError,),
                         lambda ex: {"code": ex.code, "message": ex.message,
                                     **({"line": ex.line} if ex.line is not None else {})})
        # The rebuild either refuses or writes valid YAML; anything else is a bug in rebuild_ref.
        if result.get("yamlValid") is False:
            sys.exit(f"rebuild_ref produced invalid YAML for ops {ops} on:\n{text}")
        return result

    def deviates(p: dict[str, Any], r: dict[str, Any]) -> bool:
        if "error" in p and "error" in r:
            return p["error"]["message"] != r["error"]["message"]
        return p != r

    cases = []
    for text_id, (_, body) in texts.items():
        for label, ops in op_scripts(lib, body):
            p, r = py(body, ops), rb(body, ops)
            case: dict[str, Any] = {"id": f"{text_id}/{label}", "text": text_id, "ops": ops, "python": p}
            if deviates(p, r):
                case["rebuild"] = r
            cases.append(case)
    for label, e in RENDER_CASES:
        ops = [{"op": "render", "entry": e}]
        p, r = py("", ops), rb("", ops)
        case = {"id": label, "text": None, "ops": ops, "python": p}
        if deviates(p, r):
            case["rebuild"] = r
        cases.append(case)
    return {
        "meta": meta(lib, "splice", note="Expect `rebuild` when present, else `python` (behaviors.md §0.1)."),
        "texts": {k: {"citation": c, "text": t} for k, (c, t) in texts.items()},
        "cases": cases,
    }


# --------------------------------------------------------------------------------------------
# scalar corpus
# --------------------------------------------------------------------------------------------

INDICATORS = "-?:,[]{}#&*!|>'\"%@`"
HAND_PICKED: list[str] = [
    # behaviors.md EDIT-02 observations
    "plain text", "a: b", "yes", "No", "on", "null", "~", "123", "1.5", "0x1F", "1:20", "2001-12-14", "",
    " lead", "trail ", "#hash", "x #y", "it's", "'q'", '"dq"', "- dash", "[x]", "{x}", "@at", "`bt", "%pct",
    "!bang", "&amp", "*star", "|pipe", ">gt", "?q", "?", "-", ":", "a:b", "é unicode", "tab\there", "<<", "=",
    "y", ".5", "1e3", "+1", ".inf", "NaN", "0o17", "0b101", "1_000", "https://x/y?z#w",
    # YAML 1.1 bool / null look-alikes
    "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "NO", "true", "True", "TRUE", "false", "False", "FALSE",
    "on", "On", "ON", "off", "Off", "OFF", "null", "Null", "NULL", "nUll", "tRUE", "yEs",
    # ints and floats
    "0", "-0", "+0", "012", "09", "0o12", "0x1A", "0X1A", "0b11", "-0b11", "1_000", "190:20:30", "-1", "+1",
    "1.0", "-1.5", "1.", "1.e3", "1.0e+3", "6.8523015e+5", "685.230_15e+03", "190:20:30.15", "1e10", "1E3",
    ".inf", "-.inf", "+.inf", ".Inf", ".INF", ".nan", ".NaN", ".NAN", "nan", "inf", "1:2:3", "60:00", "1:60",
    # timestamps
    "2001-12-14t21:59:43.10-05:00", "2001-12-14 21:59:43.10 -5", "2001-12-15T02:59:43.1Z", "2002-1-1", "2002-12-14x",
    # merge, value, document markers
    "<<", "=", "---", "...", "--- x", "... x", "-- x", "%YAML", "%TAG",
    # whitespace
    " ", "  ", "\t", "a\tb", " a", "a ", "\ta", "a\t", "a  b", "a \tb",
    # line breaks (multiline or escaped)
    "\n", "a\nb", "a\n", "\na", "a\rb", "a\r\nb", "a\x85b", "a\u2028b", "a\u2029b",
    # control and special characters
    "\x00", "a\x07b", "a\x1bb", "a\x7fb", "\ufeffa", "a\u200bb", "a\u00a0b", "\u00a0", "a\ufffdb",
    # non-ASCII
    "é", "日本語", "naïve café", "🙂", "a🙂b", "Ω", "ß", "İ", "\u0301", "e\u0301",
    # quotes and colons
    "'", '"', "''", '""', "a'b", 'a"b', "'a", "a'", "a: ", "a:", ":a", "a :b", "a ::b", "key: value: x",
    # URLs and paths
    "https://github.com/o/r/blob/main/skills/x/SKILL.md", "/abs/path", "~/home/path", "./rel", "C:\\path",
    "git@github.com:o/r.git", "http://x.y/#frag", "mailto:a@b.c",
    # comment-ish and flow-ish
    "a#b", "a #b", "a# b", "a,b", "a, b", "a[b]", "a{b}", "a]b", "a}b", ",a", "a,", "[]", "{}", "[ ]",
    # indicators alone, leading and trailing
    *list(INDICATORS), *[c + "x" for c in INDICATORS], *["x" + c for c in INDICATORS],
    *["x " + c for c in INDICATORS], *[c + " x" for c in INDICATORS],
]


def random_strings(n: int) -> list[str]:
    rng = random.Random(SEED)
    pools = [
        ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 50),
        (INDICATORS + ".=<~+_/\\$^()", 30),
        (" \t", 10),
        ("éßΩ日本🙂\u00a0\u2028\x85\x07", 5),
        ("eE.:-+_0123456789", 5),
    ]
    templates = ["{d}", "{d}.{d}", "{d}e{d}", "0x{h}", "0o{o}", "0b{b}", "{d}:{d}", "{d}-{d}-{d}", "{d}_{d}",
                 ".{d}", "+{d}", "-{d}", "{w}", "{W}", "~{w}"]
    words = ["yes", "no", "on", "off", "true", "false", "null", "y", "n", "inf", "nan"]
    out: list[str] = []
    while len(out) < n:
        if rng.random() < 0.15:
            t = rng.choice(templates)
            s = t.format(d=rng.randint(0, 9999), h=format(rng.randint(0, 4095), "X"), o=format(rng.randint(0, 511), "o"),
                         b=format(rng.randint(0, 63), "b"), w=rng.choice(words), W=rng.choice(words).upper())
            if rng.random() < 0.3:
                s = rng.choice(["", " ", "#", "'", "-", ":"]) + s + rng.choice(["", " ", "#", "'", ":"])
        else:
            chars = []
            for _ in range(rng.randint(0, 16)):
                pool = rng.choices([p for p, _ in pools], weights=[w for _, w in pools])[0]
                chars.append(rng.choice(pool))
            s = "".join(chars)
        out.append(s)
    return out


def scalar_corpus(lib: Any) -> dict[str, Any]:
    cases = []
    seen: set[str] = set()
    for origin, values in (("hand-picked", HAND_PICKED), ("random", random_strings(5000))):
        for v in values:
            if v in seen:
                continue
            seen.add(v)
            try:
                cases.append({"value": v, "origin": origin, "out": lib._yaml_inline(v)})
            except lib.LibraryError:
                cases.append({"value": v, "origin": origin, "multiline": True})
    return {"meta": meta(lib, "scalar", seed=SEED, function="library._yaml_inline (library.py:2673)"), "cases": cases}


# --------------------------------------------------------------------------------------------
# source corpus
# --------------------------------------------------------------------------------------------

SOURCES = [
    "/Users/you/skills/x/SKILL.md", "~/dev/skills/x/SKILL.md", "~", "/", "  /padded/path.md  ",
    "https://github.com/org/repo/blob/main/skills/x/SKILL.md",
    "https://github.com/org/repo.git/blob/main/skills/x/SKILL.md",
    "https://github.com/org/repo/blob/v1.2.3/agents/a.md",
    "https://github.com/org/repo/blob/main/SKILL.md",
    "https://github.com/org/repo/blob/main/skills/x/",
    "https://github.com/org/repo/blob/main/skills/x/SKILL.md?plain=1",
    "https://github.com/org/repo/blob/main/skills/x/SKILL.md#L10-L20",
    "https://github.com/org/repo/blob/main/a?b#c/d.md",
    "https://github.com/org/repo/blob/feature/x/skills/y/SKILL.md",
    "https://github.com/org/repo/tree/main/skills/x",
    "https://github.com/org/repo",
    "https://raw.githubusercontent.com/org/repo/main/prompts/p.md",
    "https://raw.githubusercontent.com/org/repo/refs/heads/main/prompts/p.md",
    "https://bitbucket.org/ws/repo/src/main/skills/x/SKILL.md",
    "https://bitbucket.org/ws/repo/src/main/skills/x/SKILL.md?at=main",
    "https://bitbucket.org/ws/repo/src/0123abcd/agents/a.md#lines-5",
    "https://bitbucket.org/ws/repo/raw/main/agents/a.md",
    "https://bitbucket.org/ws/repo.git/src/main/x.md",
    "http://github.com/org/repo/blob/main/x.md",
    "https://www.github.com/org/repo/blob/main/x.md",
    "https://GitHub.com/org/repo/blob/main/x.md",
    "https://gitlab.com/org/repo/-/blob/main/x.md",
    "git@github.com:org/repo.git",
    "./relative/SKILL.md", "relative/SKILL.md", "", "   ", "C:\\skills\\x\\SKILL.md",
]

CLONE_URLS = [
    "git@github.com:org/repo.git", "git@github.com:org/repo", "ssh://git@github.com/org/repo.git",
    "https://github.com/org/repo.git", "https://github.com/org/repo", "https://github.com/org/repo/",
    "git@bitbucket.org:ws/repo.git", "https://bitbucket.org/ws/repo.git", "https://user@bitbucket.org/ws/repo.git",
    "https://gitlab.com/group/sub/repo.git", "file:///tmp/repo.git", "/tmp/repo.git", "", "  https://github.com/o/r.git  ",
]


def source_corpus(lib: Any) -> dict[str, Any]:
    cases = []
    for s in SOURCES:
        try:
            src = lib.parse_source(s)
        except lib.LibraryError as ex:
            cases.append({"input": s, "error": str(ex)})
            continue
        out: dict[str, Any] = {"kind": src.kind}
        if src.kind == "local":
            out["path"] = str(src.path)
        else:
            out.update(org=src.org, repo=src.repo, branch=src.branch, filePath=src.file_path,
                       parentPath=src.parent_path, filename=src.filename, cloneUrls=src.clone_urls())
        cases.append({"input": s, "parsed": out})
    remote_web = [{"input": u, "parsed": list(r) if (r := lib._remote_web(u)) else None} for u in CLONE_URLS]
    return {"meta": meta(lib, "source", home=FAKE_HOME, functions="parse_source, Source.clone_urls, _remote_web"),
            "parseSource": cases, "remoteWeb": remote_web}


# --------------------------------------------------------------------------------------------
# hash corpus
# --------------------------------------------------------------------------------------------

def f(path: str, content: str | bytes) -> dict[str, Any]:
    if isinstance(content, bytes):
        return {"path": path, "type": "file", "base64": base64.b64encode(content).decode()}
    return {"path": path, "type": "file", "text": content}


def d(path: str) -> dict[str, Any]:
    return {"path": path, "type": "dir"}


def ln(path: str, target: str) -> dict[str, Any]:
    return {"path": path, "type": "symlink", "target": target}


SKILL = "---\nname: x\n---\n# X\n"
TREES: list[tuple[str, str, list[dict[str, Any]]]] = [  # (id, what is hashed, nodes)
    ("empty-dir", ".", []),
    ("missing-path", "nope", []),
    ("single-file-dir", ".", [f("SKILL.md", SKILL)]),
    ("single-file-target", "SKILL.md", [f("SKILL.md", SKILL), f("other.md", "ignored\n")]),
    ("empty-file", ".", [f("SKILL.md", "")]),
    ("nested", ".", [f("SKILL.md", SKILL), f("references/a.md", "a\n"), f("references/deep/b.md", "b\n"), f("scripts/run.sh", "#!/bin/sh\n")]),
    ("empty-subdir-ignored", ".", [f("SKILL.md", SKILL), d("empty"), d("also/empty")]),
    ("binary", ".", [f("SKILL.md", SKILL), f("img.bin", bytes(range(256)) + b"\0\0")]),
    ("sort-order", ".", [f("a-b", "1"), f("a.b", "2"), f("a/b", "3"), f("B", "4"), f("_z", "5"), f("Z", "6"), f("a b", "7")]),
    ("dotfiles-and-git", ".", [f("SKILL.md", SKILL), f(".hidden", "h\n"), f(".git/HEAD", "ref: refs/heads/main\n"), f(".git/config", "[core]\n")]),
    ("unicode-nfc", ".", [f("caf\u00e9.md", "nfc\n"), f("日本/語.md", "ja\n"), f("🙂.md", "emoji\n")]),
    ("unicode-nfd", ".", [f("cafe\u0301.md", "nfd\n")]),
    ("symlink-to-file", ".", [f("SKILL.md", SKILL), ln("link.md", "SKILL.md")]),
    ("symlink-to-dir-not-descended", ".", [f("SKILL.md", SKILL), f("real/x.md", "x\n"), ln("alias", "real")]),
    ("dangling-symlink", ".", [f("SKILL.md", SKILL), ln("broken", "does-not-exist")]),
    ("rename-changes-hash-a", ".", [f("one.md", "same\n")]),
    ("rename-changes-hash-b", ".", [f("two.md", "same\n")]),
    ("content-boundary-a", ".", [f("ab", "c")]),
    ("content-boundary-b", ".", [f("a", "bc")]),
    ("crlf-content", ".", [f("SKILL.md", "line\r\nline\r\n")]),
]


def hash_corpus(lib: Any) -> dict[str, Any]:
    cases = []
    for tree_id, target, nodes in TREES:
        with tempfile.TemporaryDirectory(prefix="loadout-golden-") as tmp:
            root = Path(tmp) / "tree"
            root.mkdir()
            for n in nodes:
                p = root / n["path"]
                p.parent.mkdir(parents=True, exist_ok=True)
                if n["type"] == "dir":
                    p.mkdir(exist_ok=True)
                elif n["type"] == "symlink":
                    p.symlink_to(n["target"])
                else:
                    p.write_bytes(base64.b64decode(n["base64"]) if "base64" in n else n["text"].encode())
            digest = lib.content_hash(root if target == "." else root / target)
        cases.append({"id": tree_id, "hash": target, "nodes": nodes, "contentHash": digest})
    return {"meta": meta(lib, "hash", function="library.content_hash (library.py:191)",
                         note="`hash` is the path hashed, relative to the tree root"), "cases": cases}


# --------------------------------------------------------------------------------------------
# registry corpus
# --------------------------------------------------------------------------------------------

REMOTE = "    repo: git@github.com:acme/catalog.git\n    yaml_path: library.yaml\n    branch: main\n"
REGISTRY_CASES: list[tuple[str, str]] = [
    ("valid-local-and-remote", "catalogs:\n  - id: personal\n    path: ~/dev/library.yaml\n  - id: shared\n" + REMOTE),
    ("valid-all-flags", "catalogs:\n  - id: personal\n    path: /abs/library.yaml\n    writable: false\n    git_commit: true\n"
                        "  - id: team\n" + REMOTE + "    protected: false\n    writable: true\n"
                        "pins:\n  session-retro: personal\nautopush: true\ndefault_add_catalog: personal\n"),
    ("valid-legacy", "catalog:\n  repo: git@github.com:acme/catalog.git\n  yaml_path: library.yaml\n  branch: main\n"),
    ("valid-legacy-with-extras", "catalog:\n  repo: https://bitbucket.org/ws/cat.git\n  yaml_path: cat/library.yaml\n  branch: develop\n"
                                 "default_dirs:\n  skills:\n    - global: ~/elsewhere/skills/\n    - default: .claude/skills/\nunknown_key: 1\n"),
    ("quoted-false-flags", "catalogs:\n  - id: p\n    path: ~/x.yaml\n    writable: \"false\"\n    git_commit: \"false\"\n"
                           "  - id: r\n" + REMOTE + "    protected: \"false\"\nautopush: \"false\"\n"),
    ("yaml11-booleans", "catalogs:\n  - id: p\n    path: ~/x.yaml\n    writable: no\n  - id: r\n" + REMOTE + "    protected: off\n"),
    ("non-string-id", "catalogs:\n  - id: 123\n    path: ~/x.yaml\n  - id: 2001-12-14\n    path: ~/y.yaml\n"),
    ("both-forms", "catalog:\n  repo: r\n  yaml_path: y\n  branch: b\ncatalogs: []\n"),
    ("neither-form", "pins: {}\n"),
    ("empty-document", ""),
    ("legacy-not-mapping", "catalog: just-a-string\n"),
    ("legacy-missing-keys", "catalog:\n  repo: git@github.com:acme/catalog.git\n"),
    ("catalogs-not-list", "catalogs:\n  personal: ~/x.yaml\n"),
    ("catalogs-empty", "catalogs: []\n"),
    ("item-not-mapping", "catalogs:\n  - ~/x.yaml\n  - id: ok\n    path: ~/y.yaml\n"),
    ("missing-id", "catalogs:\n  - path: ~/x.yaml\n"),
    ("blank-id", "catalogs:\n  - id: \"  \"\n    path: ~/x.yaml\n"),
    ("duplicate-id", "catalogs:\n  - id: a\n    path: ~/x.yaml\n  - id: a\n    path: ~/y.yaml\n"),
    ("path-and-repo", "catalogs:\n  - id: a\n    path: ~/x.yaml\n    repo: git@github.com:a/b.git\n"),
    ("neither-path-nor-repo", "catalogs:\n  - id: a\n    writable: true\n"),
    ("remote-missing-yaml-path-and-branch", "catalogs:\n  - id: a\n    repo: git@github.com:a/b.git\n"),
    ("yaml-path-absolute", "catalogs:\n  - id: a\n    repo: git@github.com:a/b.git\n    yaml_path: /library.yaml\n    branch: main\n"),
    ("yaml-path-dotdot", "catalogs:\n  - id: a\n    repo: git@github.com:a/b.git\n    yaml_path: x/../../library.yaml\n    branch: main\n"),
    ("yaml-path-colon", "catalogs:\n  - id: a\n    repo: git@github.com:a/b.git\n    yaml_path: \"c:library.yaml\"\n    branch: main\n"),
    ("shared-repo-and-branch", "catalogs:\n  - id: a\n" + REMOTE + "  - id: b\n" + REMOTE),
    ("same-repo-other-branch", "catalogs:\n  - id: a\n" + REMOTE + "  - id: b\n" + REMOTE.replace("main", "dev")),
    ("relative-local-path", "catalogs:\n  - id: a\n    path: dev/library.yaml\n"),
    ("pins-not-mapping", "catalogs:\n  - id: a\n    path: ~/x.yaml\npins: [a]\n"),
    ("pin-bad-key-and-value", "catalogs:\n  - id: a\n    path: ~/x.yaml\npins:\n  \"\": a\n  x: \"\"\n  y: 3\n  4: a\n"),
    ("pin-unregistered-catalog-ok", "catalogs:\n  - id: a\n    path: ~/x.yaml\npins:\n  x: nowhere\n"),
    ("many-problems", "catalogs:\n  - id: a\n  - id: a\n    path: rel\n  - 7\n  - id: c\n    repo: r\n    yaml_path: /abs\npins: 3\n"),
]


def registry_corpus(lib: Any) -> dict[str, Any]:
    import yaml
    cases = []
    for case_id, text in REGISTRY_CASES:
        data = yaml.safe_load(text) or {}
        problems = lib.Config.problems(data)
        case: dict[str, Any] = {"id": case_id, "yaml": text, "problems": problems}
        if not problems:
            cats = [lib._catalog_from_raw(item) for item in lib._normalize_catalogs(data)]
            case["catalogs"] = [
                {"id": c.id, "kind": c.kind, "writable": c.writable, "path": c.path_raw, "gitCommit": c.git_commit,
                 "repo": c.repo, "yamlPath": c.yaml_path, "branch": c.branch, "protected": c.protected}
                for c in cats
            ]
        cases.append(case)
    return {"meta": meta(lib, "registry", functions="Config.problems, _normalize_catalogs, _catalog_from_raw",
                         note="YAML parsed with yaml.safe_load (YAML 1.1), as load_config does"), "cases": cases}


# --------------------------------------------------------------------------------------------
# read corpus
# --------------------------------------------------------------------------------------------

def item(name: str, extra: str = "") -> str:
    return f"library:\n  skills:\n    - name: {name}\n      description: d\n      source: ./s\n{extra}"


READ_TEXTS: list[tuple[str, str]] = [
    *[(f"yaml11-name-{label}", item(raw)) for label, raw in [
        ("yes", "yes"), ("No", "No"), ("on", "on"), ("null", "null"), ("tilde", "~"), ("int", "123"),
        ("octal", "012"), ("hex", "0x1F"), ("float", "1.5"), ("exp", "1e3"), ("sexagesimal", "1:20"),
        ("date", "2001-12-14"), ("timestamp", "2001-12-14t21:59:43.10-05:00"), ("inf", ".inf"),
        ("quoted-yes", "'yes'"), ("double-quoted-int", '"123"'), ("empty", "''"), ("missing", "")]],
    ("requires-block", item("a", "      requires:\n        - skill:b\n        - prompt:c\n")),
    ("requires-flow-unquoted", item("a", "      requires: [skill:b, prompt:c]\n")),
    ("requires-scalar", item("a", "      requires: skill:b\n")),
    ("requires-empty", item("a", "      requires: []\n")),
    ("requires-null", item("a", "      requires:\n")),
    ("unknown-key", item("a", "      tags: [x, y]\n")),
    ("folded-description", "library:\n  skills:\n    - name: a\n      description: >\n        two\n        lines\n      source: ./s\n"),
    ("duplicate-key", "library:\n  skills:\n    - name: a\n      name: b\n      source: ./s\n"),
    ("anchor-alias", "library:\n  skills:\n    - &x {name: a, description: d, source: ./s}\n  prompts:\n    - *x\n"),
    ("merge-key", "base: &b {description: shared, source: ./s}\nlibrary:\n  skills:\n    - <<: *b\n      name: a\n"),
    ("section-null", "library:\n  skills:\n  agents: []\n"),
    ("library-null", "library:\n"),
    ("no-library", "default_dirs: {}\n"),
    ("item-is-string", "library:\n  skills:\n    - just-a-string\n"),
    ("section-is-mapping", "library:\n  skills:\n    a: {name: a}\n"),
    ("tab-indent", "library:\n\tskills: []\n"),
    ("bom", "﻿library:\n  skills: []\n"),
    ("crlf", "library:\r\n  skills:\r\n    - name: a\r\n      source: ./s\r\n"),
    ("empty-document", ""),
    ("unicode", item("café", "      requires: [\"skill:日本\"]\n")),
]


def typed(value: Any) -> Any:
    """A JSON value, or {py, repr} when the YAML 1.1 type is not a string (the TS reader must agree)."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [typed(v) for v in value]
    return {"py": type(value).__name__, "repr": repr(value)}


def read_corpus(lib: Any) -> dict[str, Any]:
    import yaml
    cases = []
    texts = [(f"splice:{k}", t) for k, (_, t) in TEXTS.items()] + READ_TEXTS
    for case_id, text in texts:
        case: dict[str, Any] = {"id": case_id, "text": text}
        try:
            data = yaml.safe_load(text)
            entries = lib.iter_entries(data or {})
            case["entries"] = [{"type": e.type, "name": typed(e.name), "description": typed(e.description),
                                "source": typed(e.source), "requires": typed(e.requires)} for e in entries]
        except Exception as ex:  # noqa: BLE001 - the error class is part of what we record
            case["error"] = {"class": type(ex).__name__, "message": str(ex).split("\n")[0]}
        cases.append(case)
    return {"meta": meta(lib, "read", functions="yaml.safe_load + library.iter_entries (library.py:1520)",
                         note="Non-string values are {py, repr}; an error records what library.py raised"),
            "cases": cases}


# --------------------------------------------------------------------------------------------

CORPORA: dict[str, Callable[..., dict[str, Any]]] = {
    "splice": splice_corpus, "scalar": scalar_corpus, "source": source_corpus,
    "hash": hash_corpus, "registry": registry_corpus, "read": read_corpus,
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old-repo", type=Path, default=Path(os.environ.get(
        "LIBRARY_SKILL_DIR", Path.home() / "Projects/my-tools/the-library-skill")))
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--check", action="store_true", help="regenerate to a temp dir and diff against --out")
    ap.add_argument("--allow-any-commit", action="store_true", help="for diffing against a newer library.py")
    args = ap.parse_args()

    old_repo = args.old_repo.expanduser().resolve()
    lib = load_library(old_repo, args.allow_any_commit)
    out = Path(tempfile.mkdtemp(prefix="loadout-golden-check-")) if args.check else args.out
    out.mkdir(parents=True, exist_ok=True)
    for name, build in CORPORA.items():
        data = build(lib, old_repo) if name == "splice" else build(lib)
        (out / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    if args.check:
        diff = subprocess.run(["git", "diff", "--no-index", "--stat", str(args.out), str(out)])
        return diff.returncode
    print(f"wrote {', '.join(CORPORA)} to {out.relative_to(REPO) if out.is_relative_to(REPO) else out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
