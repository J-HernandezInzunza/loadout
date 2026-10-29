// Claude Code's user settings file and its `skillOverrides` (architecture.md §4.5 rules 2 and 3). The
// file is the user's, also written by Claude Code itself, so every edit is the smallest one possible:
// strict JSON is checked first and anything else refused, the change is a text edit that keeps the
// rest byte for byte, the write lands next to the real file (a symlinked settings.json stays a
// symlink) with its mode kept, and a file that changed while being edited is re-read once.
import { applyEdits, modify } from "jsonc-parser";
import type { Host } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";

/** Documented values; anything else found in the file is passed through as written. */
export type OverrideValue = "on" | "name-only" | "user-invocable-only" | "off";

export interface ClaudeSettings {
  /** `<config dir>/settings.json` */
  file: string;
  /** The user's skill overrides; empty when the file or the key is absent. */
  readSkillOverrides(): Promise<Result<Map<string, string>>>;
  /** Sets each name's override, or deletes it for null; `changed` is false when nothing needed writing. */
  editSkillOverrides(changes: Record<string, OverrideValue | null>): Promise<Result<{ changed: boolean }>>;
}

type Parsed = { ok: true; data: Record<string, unknown> } | { ok: false; why: string };

function parseSettings(text: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, why: "it is not a JSON object" };
  const overrides = (data as Record<string, unknown>).skillOverrides;
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    return { ok: false, why: "its skillOverrides is not an object" };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

/** The file's own indentation and line ending, so inserted text looks like what is already there. */
function formatting(text: string) {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  const tabs = indent.startsWith("\t");
  return { insertSpaces: !tabs, tabSize: tabs ? 1 : indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

export function createClaudeSettings(host: Host, opts: { configDir?: string } = {}): ClaudeSettings {
  // CLAUDE_CONFIG_DIR, when set, comes from the app's login-shell probe; the core can't see the environment.
  const file = `${opts.configDir ?? `${host.paths.home}/.claude`}/settings.json`;
  const refuse = (why: string) =>
    err({ code: "SETTINGS" as const, message: `${file} can't be edited safely (${why}); it was left as is` });

  /** The file's text, or null when it doesn't exist. */
  const read = async (path: string) => ((await host.fs.exists(path)) ? host.fs.readText(path) : null);

  function edit(text: string | null, changes: Record<string, OverrideValue | null>): Result<string | null> {
    if (text === null) {
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null));
      return ok(Object.keys(set).length === 0 ? null : JSON.stringify({ skillOverrides: set }, null, 2) + "\n");
    }
    const parsed = parseSettings(text);
    if (!parsed.ok) return refuse(parsed.why);
    const current = (parsed.data.skillOverrides ?? {}) as Record<string, unknown>;
    const formattingOptions = formatting(text);
    let next = text;
    for (const [name, value] of Object.entries(changes)) {
      if (value === null ? !(name in current) : current[name] === value) continue;
      next = applyEdits(next, modify(next, ["skillOverrides", name], value ?? undefined, { formattingOptions }));
    }
    return ok(next);
  }

  return {
    file,

    async readSkillOverrides() {
      const text = await read(file);
      if (text === null) return ok(new Map());
      const parsed = parseSettings(text);
      if (!parsed.ok) return refuse(parsed.why);
      const overrides = (parsed.data.skillOverrides ?? {}) as Record<string, unknown>;
      return ok(new Map(Object.entries(overrides).map(([k, v]) => [k, String(v)])));
    },

    async editSkillOverrides(changes) {
      // The real file: writing beside a symlink would replace the link with a plain file.
      const real = (await host.fs.exists(file)) ? await host.fs.realPath(file) : file;
      let before = await read(real);
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = edit(before, changes);
        if (!next.ok) return next;
        if (next.value === null || next.value === before) return ok({ changed: false });
        // Claude Code may have written meanwhile: only write over the text the edit was made from.
        const now = await read(real);
        if (now !== before) {
          before = now;
          continue;
        }
        if (before === null) await host.fs.mkdirp(real.slice(0, real.lastIndexOf("/")));
        await host.fs.writeTextAtomic(real, next.value);
        host.audit({ kind: "fs", op: "write", path: real });
        return ok({ changed: true });
      }
      return refuse("it kept changing while being edited");
    },
  };
}
