// receipts.json in app data (architecture.md §4.3): one receipt per installed destination, sorted by
// dest. Every change is read → modify → write inside one queue, so concurrent updates never drop one
// another (A32, the fix for LOCK-02), and every write is atomic. A file this version can't read
// (another version, broken JSON) reads as empty and is never overwritten.
import { z } from "zod";
import type { Host } from "../host.ts";
import { EntryType, err, ok, type Result } from "../model/model.ts";

export const ReceiptV2 = z.strictObject({
  /** absolute path; the key */
  dest: z.string(),
  type: EntryType,
  name: z.string(),
  /** key = the catalog's identity (behaviors.md §1.2 catalog_key); id is a renameable nickname */
  catalog: z.strictObject({ id: z.string(), key: z.string() }),
  /** the catalog's source string, verbatim */
  source: z.string(),
  /** source repo HEAD at install; null for local sources */
  commit: z.string().nullable(),
  /** tree/blob oid of what was copied (UPD-02/03) */
  sourceOid: z.string().nullable(),
  /** posix relpath → sha256 hex */
  files: z.record(z.string(), z.string()),
  /** ISO-8601 UTC */
  installedAt: z.string(),
});
export type ReceiptV2 = z.infer<typeof ReceiptV2>;

const ReceiptsFileV2 = z.strictObject({ version: z.literal(2), installs: z.array(ReceiptV2) });

export interface ReceiptStore {
  get(dest: string): Promise<Result<ReceiptV2 | null>>;
  /** Every receipt, sorted by dest; empty with a warning when the file can't be read. */
  all(): Promise<Result<ReceiptV2[]>>;
  /** Adds or replaces the receipt for `receipt.dest`. */
  put(receipt: ReceiptV2): Promise<Result<void>>;
  /** Succeeds when there was nothing to delete. */
  delete(dest: string): Promise<Result<void>>;
}

export function createReceiptStore(host: Host): ReceiptStore {
  const file = `${host.paths.appData}/receipts.json`;
  let queue: Promise<unknown> = Promise.resolve();

  /** The receipts by dest, or why the file can't be used. */
  async function read(): Promise<{ receipts: Map<string, ReceiptV2> } | { unreadable: string }> {
    if (!(await host.fs.exists(file))) return { receipts: new Map() };
    let raw: unknown;
    try {
      raw = JSON.parse(await host.fs.readText(file));
    } catch (e) {
      return { unreadable: (e as Error).message };
    }
    const parsed = ReceiptsFileV2.safeParse(raw);
    if (!parsed.success) {
      const version = (raw as { version?: unknown } | null)?.version;
      return { unreadable: version !== 2 ? `version ${JSON.stringify(version)}` : z.prettifyError(parsed.error).split("\n").join(" ") };
    }
    return { receipts: new Map(parsed.data.installs.map((r) => [r.dest, r])) };
  }

  const ignored = (why: string) => ({ message: `${file} can't be read (${why}); treating every install as unmanaged` });

  function change(apply: (receipts: Map<string, ReceiptV2>) => boolean): Promise<Result<void>> {
    const result = queue.then(async (): Promise<Result<void>> => {
      const current = await read();
      if ("unreadable" in current) {
        return err({ code: "RECEIPTS_INVALID", message: `${file} can't be read (${current.unreadable}); it was left as is` });
      }
      if (!apply(current.receipts)) return ok(undefined);
      const installs = [...current.receipts.values()].sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0));
      await host.fs.mkdirp(host.paths.appData);
      await host.fs.writeTextAtomic(file, JSON.stringify({ version: 2, installs }, null, 2) + "\n");
      host.audit({ kind: "fs", op: "write", path: file });
      return ok(undefined);
    });
    queue = result.catch(() => {});
    return result;
  }

  return {
    async get(dest) {
      const current = await read();
      if ("unreadable" in current) return ok(null, [ignored(current.unreadable)]);
      return ok(current.receipts.get(dest) ?? null);
    },
    async all() {
      const current = await read();
      if ("unreadable" in current) return ok([], [ignored(current.unreadable)]);
      return ok([...current.receipts.values()]);
    },
    put(receipt) {
      const parsed = ReceiptV2.parse(receipt);
      return change((receipts) => {
        receipts.set(parsed.dest, parsed);
        return true;
      });
    },
    delete(dest) {
      return change((receipts) => receipts.delete(dest));
    },
  };
}
