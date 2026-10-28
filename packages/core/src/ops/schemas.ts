// Input and output schemas for every Library op (architecture.md §8.2), so tool definitions are
// generated rather than hand-written. Outputs are the `value` of the op's Result.
import { z } from "zod";
import { Entry, EntryType, Source } from "../model/model.ts";
import { ReceiptV2 } from "../receipts/receipts.ts";

const catalogOption = { catalog: z.string().exactOptional() };

const EntryRecord = Entry.extend({
  overrides: z.array(z.string()),
  overriddenBy: z.string().nullable(),
  pinned: z.boolean(),
  /** something sits at the destination, whoever put it there */
  installed: z.boolean(),
  state: z.enum(["not_installed", "installed", "drifted", "unmanaged", "stale"]),
  receipt: ReceiptV2.nullable(),
  locations: z.array(z.string()),
  /** turned off through skillOverrides */
  disabled: z.boolean(),
}).strict();

const Edits = z.strictObject({ modified: z.array(z.string()), added: z.array(z.string()), deleted: z.array(z.string()) });
const Origin = z.enum(["python-cli", "python-cli-edited", "parked-by-python-cli", "symlink", "foreign"]);

const ScanReport = z.strictObject({
  items: z.array(
    z.strictObject({
      type: EntryType,
      name: z.string(),
      path: z.string(),
      state: z.discriminatedUnion("state", [
        z.strictObject({ state: z.literal("installed"), receipt: ReceiptV2 }),
        z.strictObject({ state: z.literal("drifted"), receipt: ReceiptV2, edits: Edits }),
        z.strictObject({ state: z.literal("unmanaged"), origin: Origin }),
      ]),
      inCatalog: z.boolean().exactOptional(),
    }),
  ),
  missing: z.array(ReceiptV2),
});

const CatalogRow = z.strictObject({
  /** 1-based registry position */
  precedence: z.int(),
  id: z.string(),
  kind: z.enum(["local", "remote"]),
  location: z.string(),
  writeMode: z.enum(["local", "direct", "pr"]),
  writable: z.boolean(),
  /** null when the catalog was skipped */
  entries: z.int().nullable(),
  skipped: z.string().nullable(),
});

const EntryRef = z.strictObject({ type: EntryType, name: z.string(), catalog: z.string(), description: z.string() });

const [, RemoteSource] = Source.options;

export const EntryDetail = z.strictObject({
  name: z.string(),
  entry: EntryRecord,
  copies: z.array(
    z.strictObject({
      catalog: z.string(),
      wins: z.boolean(),
      subject: z.boolean(),
      pinned: z.boolean(),
      overrides: z.array(z.string()),
      overriddenBy: z.string().nullable(),
    }),
  ),
  /** the subject's dependencies in install order, the subject excluded */
  requires: z.array(EntryRef),
  unresolvedRequires: z.array(
    z.strictObject({ ref: z.string(), requiredBy: z.string(), reason: z.enum(["malformed", "not_found", "cycle"]) }),
  ),
  dependents: z.array(EntryRef.extend({ direct: z.boolean() })),
  /** receipts for this name and type (A26: never another type's) */
  installs: z.array(ReceiptV2),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ raw: z.string(), kind: z.literal("unknown"), error: z.string() }),
    z.strictObject({ raw: z.string(), kind: z.literal("local"), path: z.string() }),
    RemoteSource.extend({ raw: z.string(), cloneUrls: z.array(z.string()) }).strict(),
  ]),
});
export type EntryDetail = z.infer<typeof EntryDetail>;
export type CatalogRow = z.infer<typeof CatalogRow>;

export const ops = {
  list: { input: z.strictObject({ ...catalogOption, checkRemote: z.boolean().exactOptional() }), output: z.array(EntryRecord) },
  search: { input: z.strictObject({ query: z.string(), ...catalogOption }), output: z.array(EntryRecord) },
  show: { input: z.strictObject({ name: z.string(), ...catalogOption }), output: EntryDetail },
  catalogs: { input: z.strictObject({}), output: z.array(CatalogRow) },
  scan: { input: z.strictObject({}), output: ScanReport },
  refresh: {
    input: z.strictObject({}),
    output: z.array(z.strictObject({ id: z.string(), outcome: z.enum(["cloned", "pulled", "skipped"]) })),
  },
};
