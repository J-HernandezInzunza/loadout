// config.json in app data (architecture.md §4.1, as amended: no autopush, defaultAddCatalog,
// installDirs or gitCommit). Schemas are strict, so a file this version does not fully understand is
// reported and left alone rather than rewritten without the parts it dropped.
import { z } from "zod";
import type { Host } from "../host.ts";
import { CatalogRef, err, ok, type Result } from "../model/model.ts";

const [LocalCatalog, RemoteCatalog] = CatalogRef.options;

export const AppConfigV1 = z.strictObject({
  version: z.literal(1),
  catalogs: z.array(z.discriminatedUnion("kind", [LocalCatalog.strict(), RemoteCatalog.strict()])),
  pins: z.record(z.string(), z.string()),
  settings: z.strictObject({}),
  imported: z
    .strictObject({
      from: z.string(),
      at: z.string(),
      configSha256: z.string(),
      /** the Python CLI's receipts, kept only to classify what it installed (architecture.md §4.4) */
      installs: z.string().exactOptional(),
    })
    .exactOptional(),
});
export type AppConfigV1 = z.infer<typeof AppConfigV1>;

export type LoadedConfig = { state: "no-catalogs" | "ready"; config: AppConfigV1 };

export interface ConfigStore {
  loadConfig(): Promise<Result<LoadedConfig>>;
  /** Saves run one at a time, in call order. */
  saveConfig(config: AppConfigV1): Promise<Result<void>>;
}

const emptyConfig = (): AppConfigV1 => ({ version: 1, catalogs: [], pins: {}, settings: {} });

export function createConfigStore(host: Host): ConfigStore {
  const file = `${host.paths.appData}/config.json`;
  let queue: Promise<unknown> = Promise.resolve();

  /** The file on disk: absent, valid, or a CONFIG_INVALID error. */
  async function read(): Promise<Result<AppConfigV1 | undefined>> {
    if (!(await host.fs.exists(file))) return ok(undefined);
    const invalid = (why: string) =>
      err({ code: "CONFIG_INVALID", message: `${file} is not a config this version of Loadout can read (${why}); it was left as is` });
    let raw: unknown;
    try {
      raw = JSON.parse(await host.fs.readText(file));
    } catch (e) {
      return invalid((e as Error).message);
    }
    const parsed = AppConfigV1.safeParse(raw);
    if (!parsed.success) return invalid(z.prettifyError(parsed.error).split("\n").join(" "));
    return ok(parsed.data);
  }

  async function write(config: AppConfigV1): Promise<Result<void>> {
    const current = await read();
    if (!current.ok) return current;
    await host.fs.mkdirp(host.paths.appData);
    await host.fs.writeTextAtomic(file, JSON.stringify(AppConfigV1.parse(config), null, 2) + "\n");
    host.audit({ kind: "fs", op: "write", path: file });
    return ok(undefined);
  }

  return {
    async loadConfig() {
      const current = await read();
      if (!current.ok) return current;
      const config = current.value ?? emptyConfig();
      return ok({ state: config.catalogs.length === 0 ? "no-catalogs" : "ready", config });
    },
    saveConfig(config) {
      const result = queue.then(() => write(config));
      queue = result.catch(() => {});
      return result;
    },
  };
}
