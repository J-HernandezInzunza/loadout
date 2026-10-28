"""Executable form of the rebuild's splice rules (behaviors.md §0.1 D1-D4, A11).

Starts from library.py's line-based functions (behaviors.md §2.7) and changes only what the
decisions change. gen.py runs every splice case through both and records this module's result as
the case's `rebuild` expectation wherever the two differ. Pinned by test_rebuild_ref.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import yaml

PLURAL = {"skill": "skills", "agent": "agents", "prompt": "prompts"}
SECTIONS = ("skills", "agents", "prompts")
_ITEM_NAME_RE = re.compile(r"^    - name:\s*(.+?)\s*$")
_KEY_RE = re.compile(r"^      ([A-Za-z_][A-Za-z0-9_-]*):")
_BAD_REF_RE = re.compile(r'["\\\x00-\x1f\x7f]')


@dataclass
class Entry:
    type: str
    name: str
    description: str
    source: str
    requires: list[str] = field(default_factory=list)

    @property
    def section(self) -> str:
        return PLURAL[self.type]


class SpliceError(Exception):
    def __init__(self, code: str, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.line = code, message, line


def _yaml_inline(value: str) -> str:
    # Same as library.py:2673 (EDIT-02, EDIT-03); quoting is unchanged by the decisions.
    s = yaml.safe_dump({"v": value}, default_flow_style=False, allow_unicode=True, width=10**9).rstrip("\n")
    if "\n" in s:
        raise SpliceError("MULTILINE_VALUE", "multiline values are not supported in catalog entries; keep it on one line")
    return s.split(": ", 1)[1] if ": " in s else s.split(":", 1)[1].lstrip()


def render_entry(entry: Entry) -> list[str]:
    for ref in entry.requires:
        if _BAD_REF_RE.search(ref):  # A11
            raise SpliceError("INVALID_REF", f"invalid requires ref {ref!r}")
    out = [
        f"    - name: {_yaml_inline(entry.name)}",
        f"      description: {_yaml_inline(entry.description)}",
        f"      source: {_yaml_inline(entry.source)}",
    ]
    if entry.requires:
        out.append("      requires: [" + ", ".join(f'"{r}"' for r in entry.requires) + "]")
    return out


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _blank(line: str) -> bool:
    return line.strip() == ""


def _library_idx(lines: list[str]) -> int:
    idx = next((i for i, l in enumerate(lines) if re.match(r"^library:\s*$", l)), None)
    if idx is None:
        raise SpliceError("SPLICE_UNSUPPORTED", "no 'library:' key in catalog")
    return idx


def _find_section(lines: list[str], section: str) -> tuple[int, str, int] | None:
    lib_idx = _library_idx(lines)
    sec_re = re.compile(rf"^  {section}:\s*(.*)$")
    for i in range(lib_idx + 1, len(lines)):
        if re.match(r"^\S", lines[i]):
            break
        m = sec_re.match(lines[i])
        if m:
            sec_end = len(lines)
            for j in range(i + 1, len(lines)):
                l = lines[j]
                if _blank(l):
                    continue
                if re.match(r"^\S", l) or (re.match(r"^  \S", l) and not l.startswith("    ")):
                    sec_end = j
                    break
            return i, m.group(1).strip(), sec_end
    return None


def _locate_section(lines: list[str], section: str) -> tuple[int, str, int]:
    found = _find_section(lines, section)
    if found is None:
        raise SpliceError("SPLICE_UNSUPPORTED", f"section '{section}' not found under library")
    return found


def _check_layout(lines: list[str], sec_idx: int, inline: str, sec_end: int) -> None:
    """D2: refuse layouts the line-based splice would turn into invalid YAML."""
    def refuse(i: int, why: str) -> None:
        raise SpliceError("SPLICE_UNSUPPORTED", f"line {i + 1}: {why}", i + 1)

    if inline not in ("", "[]") and not inline.startswith("#"):
        refuse(sec_idx, f"section value {inline!r} is not a block list or []")
    seen_item = False
    for i in range(sec_idx + 1, sec_end):
        l = lines[i].rstrip("\r")
        if _blank(l) or l.lstrip().startswith("#"):
            continue
        if l.startswith("    - "):
            if not _ITEM_NAME_RE.match(l):
                refuse(i, "an entry must start with '- name:'")
            seen_item = True
        elif _indent(l) >= 6 and seen_item:
            continue
        else:
            refuse(i, "entries must be indented four spaces with fields at six")
    if sec_end < len(lines) and lines[sec_end].lstrip().startswith("-"):
        refuse(sec_end, "entries must be indented four spaces with fields at six")


def _items(lines: list[str], sec_idx: int, sec_end: int) -> list[tuple[str, int]]:
    return [
        (m.group(1).strip().strip("\"'"), i)
        for i in range(sec_idx + 1, sec_end)
        if lines[i].startswith("    - ") and (m := _ITEM_NAME_RE.match(lines[i]))
    ]


def _own_end(lines: list[str], target: int, limit: int) -> int:
    """Index of the item's last own line: lines indented >= 6, blanks only between them (D3)."""
    last = target
    for j in range(target + 1, limit):
        if _blank(lines[j]):
            continue
        if _indent(lines[j]) >= 6:
            last = j
        else:
            break
    return last


def _prepare(text: str, section: str) -> tuple[list[str], int, int, list[tuple[str, int]]]:
    lines = text.split("\n")
    sec_idx, inline, sec_end = _locate_section(lines, section)
    _check_layout(lines, sec_idx, inline, sec_end)
    return lines, sec_idx, sec_end, _items(lines, sec_idx, sec_end)


def _target(items: list[tuple[str, int]], name: str, section: str, sec_end: int) -> tuple[int, int]:
    for k, (nm, i) in enumerate(items):
        if nm == name:
            limit = items[k + 1][1] if k + 1 < len(items) else sec_end
            return i, limit
    raise SpliceError("NOT_FOUND", f"'{name}' not found in {section}")


def splice_entry(text: str, entry: Entry) -> str:
    section = entry.section
    lines = text.split("\n")
    block = render_entry(entry)
    if _find_section(lines, section) is None:  # D1
        prior = [s for s in SECTIONS[: SECTIONS.index(section)] if _find_section(lines, s)]
        if prior:
            p_idx, p_inline, p_end = _find_section(lines, prior[-1])  # type: ignore[misc]
            _check_layout(lines, p_idx, p_inline, p_end)  # its end is only meaningful if D2 holds
            at = p_end
            while at - 1 > p_idx and _blank(lines[at - 1]):
                at -= 1
        else:
            at = _library_idx(lines) + 1
        return "\n".join(lines[:at] + [f"  {section}:"] + block + lines[at:])

    lines, sec_idx, sec_end, items = _prepare(text, section)
    if any(nm == entry.name for nm, _ in items):
        raise SpliceError("DUPLICATE", f"'{entry.name}' already exists in {section}")
    inline = _locate_section(lines, section)[1]
    if inline == "[]":
        lines[sec_idx] = f"  {section}:"
        return "\n".join(lines[: sec_idx + 1] + block + lines[sec_idx + 1 :])
    insert_at = sec_end
    for nm, idx in items:
        if entry.name.lower() < nm.lower():
            insert_at = idx
            break
    if insert_at == sec_end:
        while insert_at - 1 > sec_idx and _blank(lines[insert_at - 1]):
            insert_at -= 1
    return "\n".join(lines[:insert_at] + block + lines[insert_at:])


def remove_entry(text: str, entry_type: str, name: str) -> str:
    section = PLURAL[entry_type]
    lines, sec_idx, sec_end, items = _prepare(text, section)
    target, limit = _target(items, name, section, sec_end)
    end = _own_end(lines, target, limit)  # inclusive
    is_last = target == items[-1][1]
    start, stop = target, end + 1
    if is_last:  # keep the separator below; take the blank lines above instead
        while start - 1 > sec_idx and _blank(lines[start - 1]):
            start -= 1
    else:
        while stop < limit and _blank(lines[stop]):
            stop += 1
    del lines[start:stop]
    if len(items) == 1:
        lines[sec_idx] = f"  {section}: []"
    return "\n".join(lines)


def _value_end(lines: list[str], key_idx: int, own_end: int) -> int:
    """Exclusive end of a key's value: deeper lines, or a same-indent '- ' block sequence."""
    j = key_idx + 1
    while j <= own_end:
        l = lines[j]
        if _blank(l) or _indent(l) > 6 or (_indent(l) == 6 and l[6:].startswith("-")):
            j += 1
        else:
            break
    while j - 1 > key_idx and _blank(lines[j - 1]):  # trailing blanks belong to nobody
        j -= 1
    return j


def replace_entry(text: str, entry_type: str, name: str, new: Entry) -> str:
    section = PLURAL[entry_type]
    lines, sec_idx, sec_end, items = _prepare(text, section)
    target, _ = _target(items, name, section, sec_end)
    rendered = render_entry(new)
    want = {"description": rendered[1], "source": rendered[2], "requires": rendered[3] if new.requires else None}

    def keys() -> dict[str, tuple[int, int]]:
        # Re-located after every edit: edits above change where the item ends.
        s_idx, _, s_end = _locate_section(lines, section)
        _, lim = _target(_items(lines, s_idx, s_end), name, section, s_end)
        own_end = _own_end(lines, target, lim)
        out: dict[str, tuple[int, int]] = {}
        for i in range(target + 1, own_end + 1):
            m = _KEY_RE.match(lines[i])
            if m and m.group(1) not in out:
                out[m.group(1)] = (i, _value_end(lines, i, own_end))
        return out

    for key in ("description", "source", "requires"):
        found = keys().get(key)
        if found:
            start, stop = found
            lines[start:stop] = [want[key]] if want[key] else []
            continue
        if want[key] is None:
            continue
        # Insert after the nearest preceding canonical key, else right under the name line.
        current = keys()
        at = target + 1
        for prev in ("name", "description", "source")[: ("description", "source", "requires").index(key) + 1]:
            if prev in current:
                at = current[prev][1]
        lines[at:at] = [want[key]]  # type: ignore[list-item]
    return "\n".join(lines)
