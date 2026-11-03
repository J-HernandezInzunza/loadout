// Which other tool put an unmanaged item in the install dirs (architecture.md §4.4). Display only: nothing
// in the core decides anything from an attribution, so a detector that misreads a tool mislabels an item
// and does no harm. Each detector knows one tool; supporting a new one is adding a detector to the list.
import type { Host } from "../host.ts";
import type { EntryType } from "../model/model.ts";
import type { Link } from "./scan.ts";

/** Who put an item there, in fields any install tool can fill; each null when the tool doesn't say. */
export interface Attribution {
  tool: string;
  source: string | null;
  installedAt: string | null;
  updatedAt: string | null;
}

/** An unmanaged item as a detector sees it: where it is and, for a link, what it points at. */
export interface Candidate {
  type: EntryType;
  path: string;
  link?: Link;
}

/** One tool's rule: its attribution for `item`, or null when the item isn't that tool's. */
export type Detector = (host: Host, item: Candidate) => Promise<Attribution | null>;

const unknown = { source: null, installedAt: null, updatedAt: null };

/**
 * `npx skills` (vercel-labs/skills) keeps its copies in `~/.agents/skills/<folder>` and links them in. Its
 * lock records each folder's source and dates; only `~/.agents/.skill-lock.json` is read, since the
 * `XDG_STATE_HOME` that moves it isn't visible to a Finder-launched app.
 */
export const npxSkills: Detector = async (host, item) => {
  if (item.type !== "skill" || item.link?.target == null) return null;
  const agents = `${host.paths.home}/.agents`;
  const copies = await host.fs.realPath(`${agents}/skills`).catch(() => `${agents}/skills`);
  if (!item.link.target.startsWith(`${copies}/`)) return null;
  // Keyed by the target's folder, which can differ from the link's name.
  const folder = item.link.target.slice(copies.length + 1).split("/")[0]!;
  return { tool: "npx skills", ...(await lockEntry(host, `${agents}/.skill-lock.json`, folder)) };
};

/** The lock's (version 3) entry for `folder`; anything unreadable is no details, never an error. */
async function lockEntry(host: Host, path: string, folder: string): Promise<Omit<Attribution, "tool">> {
  try {
    const raw = JSON.parse(await host.fs.readText(path)) as { version?: unknown; skills?: Record<string, unknown> };
    const entry = raw.version === 3 ? raw.skills?.[folder] : undefined;
    if (typeof entry !== "object" || entry === null) return unknown;
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    const { source, installedAt, updatedAt } = entry as Record<string, unknown>;
    return { source: text(source), installedAt: text(installedAt), updatedAt: text(updatedAt) };
  } catch {
    return unknown;
  }
}

/** BrowserOS keeps a real copy rather than a link, marked with a file of its own. */
export const browserOS: Detector = async (host, item) => {
  if (item.type !== "skill" || item.link) return null;
  return (await host.fs.exists(`${item.path}/.browserclaw-managed.json`)) ? { tool: "BrowserOS", ...unknown } : null;
};

/** Asked in order; the first to recognize an item names it. */
export const detectors: Detector[] = [npxSkills, browserOS];

export async function attribute(host: Host, item: Candidate, from: Detector[] = detectors): Promise<Attribution | undefined> {
  for (const detect of from) {
    const found = await detect(host, item);
    if (found) return found;
  }
  return undefined;
}
