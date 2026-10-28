// Bringing back what the Python CLI parked (architecture.md §4.5 rule 7, Q16 B). The CLI disabled a
// skill by moving it to `~/.claude/skills-disabled/<name>`; Loadout turns skills off in settings
// instead, so each parked copy moves back to `skills/<name>` and gets an "off" override. A copy whose
// destination is taken is left where it is and reported. This is the only place the app touches a
// `-disabled` folder, and it only ever takes things out of it.
import type { Host } from "../host.ts";
import { ok, type Result } from "../model/model.ts";
import { fileManifest } from "../receipts/hash.ts";
import { installDirs } from "../scan/scan.ts";
import type { ClaudeSettings } from "./settings.ts";

export interface ParkedSkill {
  name: string;
  /** `skills-disabled/<name>` */
  from: string;
  /** `skills/<name>` */
  to: string;
  /** something already sits at `to`, so this copy stays parked */
  occupied: boolean;
}

export interface MigrateReport {
  moved: string[];
  leftInPlace: { name: string; reason: string }[];
}

/** Every skill the CLI parked, and whether its way back is free. */
export async function planMigrateParked(host: Host): Promise<Result<{ items: ParkedSkill[] }>> {
  const skills = installDirs(host.paths.home).skill;
  const parked = `${skills}-disabled`;
  const entries = await host.fs.readDir(parked).catch(() => []);
  const items: ParkedSkill[] = [];
  for (const e of entries.filter((e) => e.kind !== "file" && !e.name.startsWith(".")).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const to = `${skills}/${e.name}`;
    items.push({ name: e.name, from: `${parked}/${e.name}`, to, occupied: await host.fs.exists(to) });
  }
  return ok({ items });
}

async function hasSymlink(host: Host, dir: string): Promise<boolean> {
  for (const e of await host.fs.readDir(dir)) {
    if (e.kind === "symlink") return true;
    if (e.kind === "dir" && (await hasSymlink(host, `${dir}/${e.name}`))) return true;
  }
  return false;
}

async function copyTree(host: Host, from: string, to: string): Promise<void> {
  await host.fs.mkdirp(to);
  for (const e of await host.fs.readDir(from)) {
    if (e.kind === "dir") await copyTree(host, `${from}/${e.name}`, `${to}/${e.name}`);
    else await host.fs.copyFile(`${from}/${e.name}`, `${to}/${e.name}`);
  }
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** DIS-03's move: a rename, or across volumes a copy that must match before the original goes. Null on success, else why not. */
async function moveBack(host: Host, from: string, to: string): Promise<string | null> {
  try {
    await host.fs.rename(from, to);
    host.audit({ kind: "fs", op: "move", path: from, to });
    return null;
  } catch (e) {
    if ((e as { code?: string }).code !== "EXDEV") return (e as Error).message;
  }
  // The Host can't recreate symlinks, and dropping them would lose content: leave such a copy alone.
  if (await hasSymlink(host, from)) return "it is on another volume and contains symlinks; move it back by hand";
  const discardCopy = async (why: string) => {
    await host.fs.remove(to, { recursive: true }).catch(() => {});
    host.audit({ kind: "fs", op: "delete", path: to });
    return `${why}, so the original was kept`;
  };
  try {
    await copyTree(host, from, to);
  } catch (e) {
    return discardCopy(`copying failed (${(e as Error).message})`);
  }
  host.audit({ kind: "fs", op: "copy-tree", path: from, to });
  if (!sameFiles(await fileManifest(host, from), await fileManifest(host, to))) return discardCopy("the copy didn't match the original");
  await host.fs.remove(from, { recursive: true });
  host.audit({ kind: "fs", op: "delete", path: from });
  return null;
}

export async function applyMigrateParked(ctx: { host: Host; settings: ClaudeSettings }, plan: { items: ParkedSkill[] }): Promise<Result<MigrateReport>> {
  const { host } = ctx;
  const report: MigrateReport = { moved: [], leftInPlace: [] };
  const movable: ParkedSkill[] = [];
  for (const item of plan.items) {
    // Re-checked now: the list may be older than the disk.
    if (!(await host.fs.exists(item.from))) report.leftInPlace.push({ name: item.name, reason: "it is no longer parked" });
    else if (await host.fs.exists(item.to)) report.leftInPlace.push({ name: item.name, reason: `${item.to} is already taken` });
    else movable.push(item);
  }
  if (movable.length === 0) return ok(report);

  // "off" first: a copy that moves back must never be active, even for a moment or after a failure.
  const off = await ctx.settings.editSkillOverrides(Object.fromEntries(movable.map((i) => [i.name, "off" as const])));
  if (!off.ok) return off;

  await host.fs.mkdirp(installDirs(host.paths.home).skill);
  for (const item of movable) {
    const why = await moveBack(host, item.from, item.to);
    if (why === null) report.moved.push(item.name);
    else report.leftInPlace.push({ name: item.name, reason: why });
  }
  return ok(report);
}
