// What sits in the install dirs and who put it there (architecture.md §4.4). Top level only (R9):
// that is where installs land and what Claude Code loads. A receipt makes an item managed; anything
// else is unmanaged and reported with its likely origin, never touched by the core unless a request
// names its exact path. Symlinks are reported, never followed.
import type { Host } from "../host.ts";
import { ok, type EntryType, type Result } from "../model/model.ts";
import { contentHashV1, fileManifest } from "../receipts/hash.ts";
import type { ReceiptStore, ReceiptV2 } from "../receipts/receipts.ts";

/** INST-01 (rebuild: fixed, no `default_dirs`). */
export function installDirs(home: string): Record<EntryType, string> {
  return { skill: `${home}/.claude/skills`, agent: `${home}/.claude/agents`, prompt: `${home}/.claude/commands` };
}

/** INST-01: skill → `skills/<name>/`, agent → `agents/<name>.md`, prompt → `commands/<name>.md`. */
export function destFor(home: string, type: EntryType, name: string): string {
  const dir = installDirs(home)[type];
  return type === "skill" ? `${dir}/${name}` : `${dir}/${name}.md`;
}

export type Origin = "python-cli" | "python-cli-edited" | "parked-by-python-cli" | "symlink" | "foreign";

export interface Edits {
  modified: string[];
  added: string[];
  deleted: string[];
}

export type DestState =
  | { state: "absent" }
  | { state: "installed"; receipt: ReceiptV2 }
  /** INST-08 (rebuild): which files differ from what was installed */
  | { state: "drifted"; receipt: ReceiptV2; edits: Edits }
  | { state: "unmanaged"; origin: Origin };

export interface ScanItem {
  type: EntryType;
  name: string;
  path: string;
  state: Exclude<DestState, { state: "absent" }>;
  /** set when the caller says whether a catalog entry of that type and name exists */
  inCatalog?: boolean;
}

export interface ScanReport {
  items: ScanItem[];
  /** SYNC-06: receipts whose destination is gone; reported, never acted on */
  missing: ReceiptV2[];
}

/** The Python CLI's receipts (`.installs.json`, version 1): dest → content_hash. Anything unreadable is no hints. */
export async function readLegacyInstalls(host: Host, path: string | undefined): Promise<Map<string, string>> {
  if (path === undefined) return new Map();
  try {
    const raw = JSON.parse(await host.fs.readText(path)) as { version?: unknown; installs?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.installs)) return new Map();
    return new Map(
      raw.installs
        .filter((r): r is { dest: string; content_hash: string } => typeof r?.dest === "string" && typeof r?.content_hash === "string")
        .map((r) => [r.dest, r.content_hash]),
    );
  } catch {
    return new Map();
  }
}

function compare(recorded: Record<string, string>, onDisk: Record<string, string>): Edits {
  const sorted = (xs: string[]) => xs.sort();
  return {
    modified: sorted(Object.keys(recorded).filter((f) => f in onDisk && onDisk[f] !== recorded[f])),
    added: sorted(Object.keys(onDisk).filter((f) => !(f in recorded))),
    deleted: sorted(Object.keys(recorded).filter((f) => !(f in onDisk))),
  };
}

/** One destination's state: what install, sync and uninstall check before they touch it. */
export async function destState(
  host: Host,
  dest: string,
  receipt: ReceiptV2 | null,
  legacy: Map<string, string> = new Map(),
): Promise<DestState> {
  const kind = await host.fs.lstat(dest).then((s) => s.kind, () => null);
  if (kind === null) return { state: "absent" };
  if (kind === "symlink") return { state: "unmanaged", origin: "symlink" };
  if (receipt !== null) {
    const edits = compare(receipt.files, await fileManifest(host, dest));
    const clean = edits.modified.length + edits.added.length + edits.deleted.length === 0;
    return clean ? { state: "installed", receipt } : { state: "drifted", receipt, edits };
  }
  const hash = legacy.get(dest);
  if (hash === undefined) return { state: "unmanaged", origin: "foreign" };
  return { state: "unmanaged", origin: (await contentHashV1(host, dest)) === hash ? "python-cli" : "python-cli-edited" };
}

/** SCAN-01's skip rule: dot names (`.trash`, the CLI's own dot dirs) and claude.ai's `synced`. */
const skipped = (name: string) => name.startsWith(".") || name.toLowerCase() === "synced";

/** Top-level items of an install dir: dirs (and links) in skills/; `*.md` files (and links) plus namespace dirs elsewhere. */
async function topLevel(host: Host, type: EntryType, dir: string): Promise<{ name: string; path: string }[]> {
  const entries = await host.fs.readDir(dir).catch(() => []);
  return entries
    .filter((e) => !skipped(e.name))
    .flatMap((e) => {
      const path = `${dir}/${e.name}`;
      if (type === "skill") return e.kind === "file" ? [] : [{ name: e.name, path }];
      if (e.name.endsWith(".md") && e.kind !== "dir") return [{ name: e.name.slice(0, -3), path }];
      // `commands/<ns>/` holds namespaced prompts: listed as one unmanaged item, not descended.
      return type === "prompt" && e.kind === "dir" ? [{ name: e.name, path }] : [];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function scanInstallDirs(
  host: Host,
  receipts: ReceiptStore,
  opts: { legacyInstalls?: string; inCatalog?: (type: EntryType, name: string) => boolean } = {},
): Promise<Result<ScanReport>> {
  const all = await receipts.all();
  if (!all.ok) return all;
  const byDest = new Map(all.value.map((r) => [r.dest, r]));
  const legacy = await readLegacyInstalls(host, opts.legacyInstalls);
  const dirs = installDirs(host.paths.home);
  const items: ScanItem[] = [];
  const note = (item: ScanItem) => items.push(opts.inCatalog ? { ...item, inCatalog: opts.inCatalog(item.type, item.name) } : item);

  for (const type of ["skill", "agent", "prompt"] as const) {
    for (const { name, path } of await topLevel(host, type, dirs[type])) {
      const state = await destState(host, path, byDest.get(path) ?? null, legacy);
      if (state.state !== "absent") note({ type, name, path, state });
    }
    // Only to find what the Python CLI parked (§4.5 rule 7); the app never writes there.
    for (const { name, path } of await topLevel(host, type, `${dirs[type]}-disabled`)) {
      note({ type, name, path, state: { state: "unmanaged", origin: "parked-by-python-cli" } });
    }
  }

  const missing: ReceiptV2[] = [];
  for (const r of all.value) if (!(await host.fs.exists(r.dest))) missing.push(r);
  return ok({ items, missing }, all.warnings);
}
