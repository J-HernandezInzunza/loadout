// Typed readers for the golden fixtures in ./golden (architecture.md §3.2). The schemas are strict,
// so a regenerated fixture with a shape nobody reads fails here instead of being half-tested.
import { readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Entry, EntryType, ErrorCode, Source } from "../src/model/model.ts";

const Meta = z.looseObject({
  corpus: z.string(),
  generator: z.string(),
  library: z.strictObject({ repo: z.string(), commit: z.string() }),
  python: z.string(),
  pyyaml: z.string(),
});

/** An entry as written to a catalog: no catalog id yet. */
const FixtureEntry = Entry.omit({ catalog: true }).strict();
export type FixtureEntry = z.infer<typeof FixtureEntry>;

const SpliceOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("splice"), entry: FixtureEntry }),
  z.strictObject({ op: z.literal("render"), entry: FixtureEntry }),
  z.strictObject({ op: z.literal("remove"), type: EntryType, name: z.string() }),
  z.strictObject({ op: z.literal("replace"), type: EntryType, name: z.string(), entry: FixtureEntry }),
]);

const SpliceError = z.strictObject({
  code: ErrorCode.exactOptional(),
  message: z.string(),
  line: z.int().exactOptional(),
});

const SpliceOutcome = z.union([
  z.strictObject({ text: z.string(), yamlValid: z.boolean() }),
  z.strictObject({ lines: z.array(z.string()) }),
  z.strictObject({ error: SpliceError }),
]);

const SpliceCase = z.strictObject({
  id: z.string(),
  /** a key of `texts`; null for render cases */
  text: z.string().nullable(),
  ops: z.array(SpliceOp).min(1),
  python: SpliceOutcome,
  rebuild: SpliceOutcome.exactOptional(),
});
export type SpliceCase = z.infer<typeof SpliceCase>;

const [LocalSource, RemoteSource] = Source.options;

/** A value read from YAML: a string, or a non-string Python value as its type and repr. */
const ReadValue = z.union([z.string(), z.strictObject({ py: z.string(), repr: z.string() })]);

const HashNode = z.union([
  z.strictObject({ path: z.string(), type: z.literal("file"), text: z.string() }),
  z.strictObject({ path: z.string(), type: z.literal("file"), base64: z.base64() }),
  z.strictObject({ path: z.string(), type: z.literal("dir") }),
  z.strictObject({ path: z.string(), type: z.literal("symlink"), target: z.string() }),
]);

const HashCase = z.strictObject({
  id: z.string(),
  /** the path hashed, relative to the tree root */
  hash: z.string(),
  nodes: z.array(HashNode),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type HashCase = z.infer<typeof HashCase>;

export const goldenSchemas = {
  splice: z.strictObject({
    meta: Meta,
    texts: z.record(z.string(), z.strictObject({ citation: z.string(), text: z.string() })),
    cases: z.array(SpliceCase),
  }),
  scalar: z.strictObject({
    meta: Meta,
    cases: z.array(
      z.union([
        z.strictObject({ value: z.string(), origin: z.enum(["hand-picked", "random"]), out: z.string() }),
        z.strictObject({ value: z.string(), origin: z.enum(["hand-picked", "random"]), multiline: z.literal(true) }),
      ]),
    ),
  }),
  source: z.strictObject({
    meta: Meta.extend({ home: z.string() }),
    parseSource: z.array(
      z.union([
        z.strictObject({ input: z.string(), parsed: LocalSource.strict() }),
        z.strictObject({ input: z.string(), parsed: RemoteSource.extend({ cloneUrls: z.array(z.string()) }).strict() }),
        z.strictObject({ input: z.string(), error: z.string() }),
      ]),
    ),
    remoteWeb: z.array(
      z.strictObject({ input: z.string(), parsed: z.tuple([z.string(), z.string(), z.string()]).nullable() }),
    ),
  }),
  hash: z.strictObject({ meta: Meta, cases: z.array(HashCase) }),
  registry: z.strictObject({
    meta: Meta,
    cases: z.array(
      z.strictObject({
        id: z.string(),
        yaml: z.string(),
        problems: z.array(z.string()),
        /** the normalized catalogs, for valid configs only */
        catalogs: z
          .array(
            z.strictObject({
              id: z.string(),
              kind: z.enum(["local", "remote"]),
              writable: z.boolean(),
              path: z.string(),
              gitCommit: z.boolean(),
              repo: z.string(),
              yamlPath: z.string(),
              branch: z.string(),
              protected: z.boolean(),
            }),
          )
          .exactOptional(),
      }),
    ),
  }),
  read: z.strictObject({
    meta: Meta,
    cases: z.array(
      z.union([
        z.strictObject({
          id: z.string(),
          text: z.string(),
          entries: z.array(
            z.strictObject({
              type: EntryType,
              name: ReadValue,
              description: ReadValue,
              source: ReadValue,
              requires: z.array(ReadValue),
            }),
          ),
        }),
        z.strictObject({ id: z.string(), text: z.string(), error: z.strictObject({ class: z.string(), message: z.string() }) }),
      ]),
    ),
  }),
};

type Golden = { [N in keyof typeof goldenSchemas]: z.infer<(typeof goldenSchemas)[N]> };

export function loadGolden<N extends keyof Golden>(name: N): Golden[N] {
  const raw: unknown = JSON.parse(readFileSync(new URL(`golden/${name}.json`, import.meta.url), "utf8"));
  return goldenSchemas[name].parse(raw) as Golden[N];
}

/** What the rebuild must produce: the `rebuild` expectation when there is one (behaviors.md §0.1). */
export function expected(c: SpliceCase) {
  return c.rebuild ?? c.python;
}

export interface SpliceImpl {
  renderEntry(e: FixtureEntry): string[];
  spliceEntry(text: string, e: FixtureEntry): string;
  removeEntry(text: string, type: EntryType, name: string): string;
  replaceEntry(text: string, type: EntryType, name: string, e: FixtureEntry): string;
}

export type Replayed = { text: string } | { lines: string[] } | { error: z.infer<typeof SpliceError> };

/** Runs a case's ops in order on its text; a throw becomes `{ error }` with its code and line, if any. */
export function replaySplice(fixture: Golden["splice"], c: SpliceCase, impl: SpliceImpl): Replayed {
  try {
    if (c.text === null) {
      const [op] = c.ops;
      if (c.ops.length !== 1 || op?.op !== "render") throw new Error(`${c.id}: a case without text must be one render`);
      return { lines: impl.renderEntry(op.entry) };
    }
    let text = fixture.texts[c.text]!.text;
    for (const op of c.ops) {
      if (op.op === "splice") text = impl.spliceEntry(text, op.entry);
      else if (op.op === "remove") text = impl.removeEntry(text, op.type, op.name);
      else if (op.op === "replace") text = impl.replaceEntry(text, op.type, op.name, op.entry);
      else throw new Error(`${c.id}: render needs a case without text`);
    }
    return { text };
  } catch (e) {
    const { code, message, line } = e as { code?: ErrorCode; message: string; line?: number };
    return { error: { ...(code !== undefined && { code }), message, ...(line !== undefined && { line }) } };
  }
}

/** Writes a hash case's tree under `dir` and returns the path the case hashes. */
export async function materializeTree(dir: string, c: HashCase): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const node of c.nodes) {
    const path = join(dir, node.path);
    await mkdir(dirname(path), { recursive: true });
    if (node.type === "dir") await mkdir(path, { recursive: true });
    else if (node.type === "symlink") await symlink(node.target, path);
    else await writeFile(path, "text" in node ? node.text : Buffer.from(node.base64, "base64"));
  }
  return join(dir, c.hash);
}
