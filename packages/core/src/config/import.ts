// The one-time import of the Python CLI's config.local.yaml (architecture.md §4.2, MIG-01, MIG-03).
// It only reads the old tool dir; settings Loadout dropped are reported, never carried over.
import { pyStr, strip, truthy } from "../catalog/python.ts";
import { parseYamlMaps } from "../catalog/read.ts";
import { resolvers } from "../catalog/scalar.ts";
import type { Host } from "../host.ts";
import { err, ok, type CoreError, type Result } from "../model/model.ts";
import type { AppConfigV1, ConfigStore } from "./config.ts";
import { validateRegistry } from "./registry.ts";

export interface ImportPlan {
  toolDir: string;
  configFile: string;
  /** what applyImport checks the old file against */
  configSha256: string;
  /** `<tool dir>/.installs.json`, when present */
  installs?: string;
  config: AppConfigV1;
  /** one line per setting the import leaves behind */
  notImported: string[];
}

export type ImportErr = CoreError & { problems?: string[] };

export interface ImportReport {
  catalogs: number;
  pins: number;
  notImported: string[];
}

type Mapping = Map<unknown, unknown>;

const DROPPED: Record<string, string> = {
  autopush: "pull requests open only when you ask",
  default_add_catalog: "Loadout asks which catalog when there is more than one",
  default_dirs: "install locations are fixed",
};
const KNOWN = new Set(["catalog", "catalogs", "pins", ...Object.keys(DROPPED)]);

/**
 * A flag read strictly: YAML booleans as they are, a quoted YAML boolean word as that word means
 * (reported when the CLI's bool() read it the other way, A22), anything else as the CLI read it.
 */
function flag(item: Mapping, key: string, fallback: boolean, where: string, notes: string[]): boolean {
  if (!item.has(key)) return fallback;
  const value = item.get(key);
  if (typeof value === "boolean") return value;
  const cli = truthy(value);
  if (typeof value === "string" && resolvers.bool.test(value)) {
    const strict = ["yes", "true", "on"].includes(value.toLowerCase());
    if (strict !== cli) notes.push(`${where} ${key}: "${value}" is quoted; the CLI read it as ${cli}, Loadout imports ${strict}`);
    return strict;
  }
  notes.push(`${where} ${key}: ${pyStr(value)} is not true or false; imported as ${cli}, as the CLI read it`);
  return cli;
}

/** The registry's catalogs as config.json stores them, defaults explicit (MIG-01). */
function catalogsOf(data: Mapping, notes: string[]): AppConfigV1["catalogs"] {
  const legacy = data.get("catalog");
  const items = (legacy instanceof Map ? [new Map([["id", "shared"], ...legacy])] : data.get("catalogs")) as Mapping[];
  return items.map((item) => {
    const id = strip(pyStr(item.get("id")));
    const where = `catalog '${id}'`;
    if (truthy(item.get("path"))) {
      const writable = flag(item, "writable", true, where, notes);
      if (item.has("git_commit")) notes.push(`${where} git_commit: not imported (Loadout never commits local catalogs)`);
      return { id, kind: "local", path: pyStr(item.get("path")), writable };
    }
    return {
      id,
      kind: "remote",
      repo: pyStr(item.get("repo")),
      yamlPath: pyStr(item.get("yaml_path")),
      branch: pyStr(item.get("branch")),
      protected: flag(item, "protected", true, where, notes),
      writable: flag(item, "writable", true, where, notes),
    };
  });
}

/** Without `toolDir`, finds the tool through the `~/.claude/skills/library` link `library link` made. */
export async function planImport(host: Host, toolDir?: string): Promise<Result<ImportPlan, ImportErr>> {
  const link = `${host.paths.home}/.claude/skills/library`;
  let dir = toolDir;
  if (dir === undefined) {
    dir = await host.fs.realPath(link).catch(() => undefined);
    if (dir === undefined) return err({ code: "NOT_FOUND", message: `no Python CLI at ${link}; pick its folder instead` });
  }
  const configFile = `${dir}/config.local.yaml`;
  if (!(await host.fs.exists(configFile))) return err({ code: "NOT_FOUND", message: `${configFile} does not exist` });

  const bytes = await host.fs.readBytes(configFile);
  const parsed = parseYamlMaps(new TextDecoder().decode(bytes));
  const problems = parsed.ok ? validateRegistry(parsed.data) : [parsed.problem.message];
  if (!parsed.ok || problems.length > 0) {
    return err({ code: "CONFIG_INVALID", message: `${configFile} can't be imported until these are fixed`, problems });
  }

  const data = parsed.data as Mapping;
  const notImported: string[] = [];
  const catalogs = catalogsOf(data, notImported);
  for (const key of data.keys()) {
    if (typeof key === "string" && DROPPED[key]) notImported.push(`${key}: not imported (${DROPPED[key]})`);
    else if (!KNOWN.has(key as string)) notImported.push(`${pyStr(key)}: not imported (unknown setting)`);
  }
  const pins = truthy(data.get("pins")) ? Object.fromEntries(data.get("pins") as Map<string, string>) : {};
  const installs = `${dir}/.installs.json`;
  return ok({
    toolDir: dir,
    configFile,
    configSha256: await host.sha256(bytes),
    ...((await host.fs.exists(installs)) && { installs }),
    config: { version: 1, catalogs, pins, settings: {} },
    notImported,
  });
}

/** Writes config.json from the plan; the old file is only read, to check it has not changed. */
export async function applyImport(host: Host, store: ConfigStore, plan: ImportPlan): Promise<Result<ImportReport>> {
  const bytes = await host.fs.readBytes(plan.configFile).catch(() => undefined);
  if (bytes === undefined || (await host.sha256(bytes)) !== plan.configSha256) {
    return err({ code: "STALE_PLAN", message: `${plan.configFile} changed after the import was planned; plan it again` });
  }
  const current = await store.loadConfig();
  if (!current.ok) return current;
  if (current.value.state === "ready") {
    return err({ code: "REFUSED", message: "Loadout already has catalogs registered; importing would replace them" });
  }
  const imported = {
    from: plan.configFile,
    at: host.now().toISOString(),
    configSha256: plan.configSha256,
    ...(plan.installs !== undefined && { installs: plan.installs }),
  };
  const saved = await store.saveConfig({ ...plan.config, imported });
  if (!saved.ok) return saved;
  return ok({ catalogs: plan.config.catalogs.length, pins: Object.keys(plan.config.pins).length, notImported: plan.notImported });
}
