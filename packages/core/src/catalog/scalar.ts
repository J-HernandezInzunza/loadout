// A one-line YAML scalar exactly as PyYAML 6 writes the value of `{"v": value}` under
// `safe_dump(default_flow_style=False, allow_unicode=True, width=10**9)` (EDIT-02, library.py
// `_yaml_inline`): YAML 1.1 implicit resolvers decide whether plain is ambiguous, the emitter's
// `analyze_scalar` decides which styles are allowed, and the single- and double-quoted writers run
// with a width that never wraps.
import { LibraryError } from "../model/model.ts";

// PyYAML's Resolver: a plain scalar matching one of these would not read back as a string.
const implicitResolvers = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:<<)$/,
  /^(?:~|null|Null|NULL|)$/,
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  /^(?:=)$/,
  /^(?:!|&|\*)$/,
];

const BREAKS = "\n\x85  ";
const WHITESPACE = "\0 \t\r" + BREAKS;

// Emitter.ESCAPE_REPLACEMENTS
const escapes: Record<string, string> = {
  "\0": "0",
  "\x07": "a",
  "\x08": "b",
  "\t": "t",
  "\n": "n",
  "\x0B": "v",
  "\x0C": "f",
  "\r": "r",
  "\x1B": "e",
  '"': '"',
  "\\": "\\",
  "\x85": "N",
  "\xA0": "_",
  " ": "L",
  " ": "P",
};

const cp = (ch: string) => ch.codePointAt(0)!;
const isBreak = (ch: string | undefined) => ch !== undefined && BREAKS.includes(ch);

/** Printable outside ASCII; with allow_unicode it needs no escaping. */
function isUnicodePrintable(ch: string): boolean {
  const c = cp(ch);
  if (c === 0xfeff) return false;
  return c === 0x85 || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c < 0x10ffff);
}

/** Emitter.analyze_scalar, reduced to the two styles a block mapping value can take. */
function analyze(chars: string[]): { blockPlain: boolean; singleQuoted: boolean } {
  if (chars.length === 0) return { blockPlain: true, singleQuoted: true };
  const text = chars.join("");
  let blockIndicators = text.startsWith("---") || text.startsWith("...");
  let lineBreaks = false;
  let special = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let precededByWhitespace = true;
  let previousSpace = false;
  let previousBreak = false;

  chars.forEach((ch, i) => {
    const next = chars[i + 1];
    const followedByWhitespace = next === undefined || WHITESPACE.includes(next);
    if (i === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) blockIndicators = true;
      if ("?:".includes(ch) && followedByWhitespace) blockIndicators = true;
      if (ch === "-" && followedByWhitespace) blockIndicators = true;
    } else {
      if (ch === ":" && followedByWhitespace) blockIndicators = true;
      if (ch === "#" && precededByWhitespace) blockIndicators = true;
    }

    if (isBreak(ch)) lineBreaks = true;
    const c = cp(ch);
    if (!(ch === "\n" || (c >= 0x20 && c <= 0x7e)) && !isUnicodePrintable(ch)) special = true;

    if (ch === " ") {
      if (i === 0) leadingSpace = true;
      if (i === chars.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (isBreak(ch)) {
      if (i === 0) leadingBreak = true;
      if (i === chars.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWhitespace = WHITESPACE.includes(ch);
  });

  let blockPlain = true;
  let singleQuoted = true;
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) blockPlain = false;
  if (breakSpace) blockPlain = singleQuoted = false;
  if (spaceBreak || special) blockPlain = singleQuoted = false;
  if (lineBreaks || blockIndicators) blockPlain = false;
  return { blockPlain, singleQuoted };
}

/** Emitter.write_single_quoted: `'` doubled; a run of breaks is followed by the value's indent (2). */
function singleQuoted(chars: string[]): string {
  const body = chars.map((ch, i) => (ch === "'" ? "''" : ch) + (isBreak(ch) && !isBreak(chars[i + 1]) ? "  " : ""));
  return `'${body.join("")}'`;
}

/** Emitter.write_double_quoted with allow_unicode: astral characters are still escaped. */
function doubleQuoted(chars: string[]): string {
  const body = chars.map((ch) => {
    const c = cp(ch);
    const plain = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd);
    if (plain && !'"\\\x85  ﻿'.includes(ch)) return ch;
    const hex = c.toString(16).toUpperCase();
    if (escapes[ch] !== undefined) return "\\" + escapes[ch];
    if (c <= 0xff) return "\\x" + hex.padStart(2, "0");
    if (c <= 0xffff) return "\\u" + hex.padStart(4, "0");
    return "\\U" + hex.padStart(8, "0");
  });
  return `"${body.join("")}"`;
}

function emit(value: string): string {
  const chars = Array.from(value);
  const { blockPlain, singleQuoted: single } = analyze(chars);
  const resolvesToString = !implicitResolvers.some((r) => r.test(value));
  if (resolvesToString && blockPlain) return value;
  if (single) return singleQuoted(chars);
  return doubleQuoted(chars);
}

/**
 * Refuses only what would span lines: a newline that PyYAML writes raw in a single-quoted scalar.
 * A value that must be double-quoted anyway (say it also holds `\r` or a tab) escapes its `\n`.
 */
export function pyyamlInline(value: string): string {
  const out = emit(value);
  if (out.includes("\n")) {
    throw new LibraryError("MULTILINE_VALUE", "multiline values are not supported in catalog entries; keep it on one line");
  }
  return out;
}
