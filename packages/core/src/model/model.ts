// Domain types shared by every core module (behaviors.md §1, architecture.md §2.3). Each type is
// its zod schema's inferred shape, so op inputs and outputs can be validated and turned into tool
// definitions (architecture.md §8.2).
import { z } from "zod";

export const EntryType = z.enum(["skill", "agent", "prompt"]);
export type EntryType = z.infer<typeof EntryType>;

/** One catalog item, stamped with the id of the catalog it was read from (§1.4). */
export const Entry = z.object({
  type: EntryType,
  name: z.string(),
  description: z.string(),
  source: z.string(),
  requires: z.array(z.string()),
  catalog: z.string(),
});
export type Entry = z.infer<typeof Entry>;

/** A parsed entry source (§1.5). */
export const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), path: z.string() }),
  z.object({
    kind: z.enum(["github", "bitbucket"]),
    org: z.string(),
    repo: z.string(),
    branch: z.string(),
    filePath: z.string(),
    parentPath: z.string(),
    filename: z.string(),
  }),
]);
export type Source = z.infer<typeof Source>;

/** A registered catalog as stored in config.json (architecture.md §4.1). */
export const CatalogRef = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("local"), path: z.string(), writable: z.boolean().exactOptional() }),
  z.object({
    id: z.string(),
    kind: z.literal("remote"),
    repo: z.string(),
    yamlPath: z.string(),
    branch: z.string(),
    protected: z.boolean(),
    writable: z.boolean().exactOptional(),
  }),
]);
export type CatalogRef = z.infer<typeof CatalogRef>;

/** Closed: messages are for humans, codes for callers (architecture.md §8.5). */
export const ErrorCode = z.enum([
  "NOT_FOUND",
  "AMBIGUOUS_NAME",
  "AMBIGUOUS_CATALOG",
  "READ_ONLY",
  "LOCAL_SOURCE_REFUSED",
  "SOURCE_IN_INSTALL_DIR",
  "DUPLICATE",
  "SPLICE_UNSUPPORTED",
  "MULTILINE_VALUE",
  "NO_WRITABLE_CATALOG",
  "INVALID_REF",
  "STALE_PLAN",
  "REFUSED",
  "VERIFY_FAILED",
  "SETTINGS",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const CoreError = z.object({ code: ErrorCode, message: z.string() });
export type CoreError = z.infer<typeof CoreError>;

/** Thrown by the pure catalog functions; ops turn it into an `err()` result. */
export class LibraryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

export const Warning = z.object({ message: z.string() });
export type Warning = z.infer<typeof Warning>;

/** Decisions and failures travel as results, never as throws or prompts (architecture.md §8.4). */
export type Result<T, E extends CoreError = CoreError> =
  | { ok: true; value: T; warnings: Warning[] }
  | { ok: false; error: E; warnings: Warning[] };

export function Result<T extends z.ZodType, E extends z.ZodType<CoreError> = typeof CoreError>(
  value: T,
  error: E = CoreError as unknown as E,
) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value, warnings: z.array(Warning) }),
    z.object({ ok: z.literal(false), error, warnings: z.array(Warning) }),
  ]);
}

export function ok<T>(value: T, warnings: Warning[] = []): Result<T, never> {
  return { ok: true, value, warnings };
}

export function err<E extends CoreError>(error: E, warnings: Warning[] = []): Result<never, E> {
  return { ok: false, error, warnings };
}
