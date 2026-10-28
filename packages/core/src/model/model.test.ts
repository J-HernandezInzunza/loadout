import { describe, expect, it } from "vitest";
import { CatalogRef, CoreError, Entry, ErrorCode, Result, Source, Warning, err, ok } from "./model.ts";
import { z } from "zod";

const entry: Entry = {
  type: "skill",
  name: "commit-and-push",
  description: "Commit staged changes and push",
  source: "https://github.com/org/repo/blob/main/skills/commit/SKILL.md",
  requires: ["prompt:commit-style"],
  catalog: "team",
};

const sources: Source[] = [
  { kind: "local", path: "/Users/you/skills/x/SKILL.md" },
  {
    kind: "github",
    org: "org",
    repo: "repo",
    branch: "main",
    filePath: "skills/x/SKILL.md",
    parentPath: "skills/x",
    filename: "SKILL.md",
  },
  {
    kind: "bitbucket",
    org: "ws",
    repo: "repo",
    branch: "main",
    filePath: "agents/a.md",
    parentPath: "agents",
    filename: "a.md",
  },
];

const catalogs: CatalogRef[] = [
  { id: "mine", kind: "local", path: "~/library.yaml" },
  { id: "drafts", kind: "local", path: "/tmp/drafts", writable: false },
  { id: "team", kind: "remote", repo: "git@bitbucket.org:ws/lib.git", yamlPath: "library.yaml", branch: "main", protected: true },
];

const warning: Warning = { message: "catalog 'team' was skipped: not cloned yet" };
const error: CoreError = { code: "NOT_FOUND", message: "no entry named 'x'" };

describe("model schemas", () => {
  it("round-trip an entry", () => {
    expect(Entry.parse(entry)).toEqual(entry);
  });

  it.each(sources)("round-trip a $kind source", (source) => {
    expect(Source.parse(source)).toEqual(source);
  });

  it.each(catalogs)("round-trip catalog ref $id", (catalog) => {
    expect(CatalogRef.parse(catalog)).toEqual(catalog);
  });

  it("round-trip a warning and an error", () => {
    expect(Warning.parse(warning)).toEqual(warning);
    expect(CoreError.parse(error)).toEqual(error);
  });

  it("round-trip both arms of a result", () => {
    const schema = Result(z.array(Entry));
    const success = ok([entry], [warning]);
    const failure = err(error);
    expect(schema.parse(success)).toEqual(success);
    expect(schema.parse(failure)).toEqual(failure);
  });

  it("reject an unknown entry type, error code or source kind", () => {
    expect(Entry.safeParse({ ...entry, type: "tool" }).success).toBe(false);
    expect(CoreError.safeParse({ code: "OOPS", message: "" }).success).toBe(false);
    expect(Source.safeParse({ kind: "gitlab", path: "x" }).success).toBe(false);
  });

  it("reject an explicit undefined for an optional field", () => {
    expect(CatalogRef.safeParse({ id: "mine", kind: "local", path: "/x", writable: undefined }).success).toBe(false);
  });
});

describe("result helpers", () => {
  it("ok carries the value and defaults to no warnings", () => {
    expect(ok(3)).toEqual({ ok: true, value: 3, warnings: [] });
    expect(ok(3, [warning])).toEqual({ ok: true, value: 3, warnings: [warning] });
  });

  it("err carries the error and defaults to no warnings", () => {
    expect(err(error)).toEqual({ ok: false, error, warnings: [] });
    expect(err(error, [warning])).toEqual({ ok: false, error, warnings: [warning] });
  });
});

// Adding a code without a case here fails the typecheck: the enum is closed.
function codeName(code: ErrorCode): string {
  switch (code) {
    case "NOT_FOUND":
    case "AMBIGUOUS_NAME":
    case "AMBIGUOUS_CATALOG":
    case "READ_ONLY":
    case "LOCAL_SOURCE_REFUSED":
    case "SOURCE_IN_INSTALL_DIR":
    case "DUPLICATE":
    case "SPLICE_UNSUPPORTED":
    case "MULTILINE_VALUE":
    case "NO_WRITABLE_CATALOG":
    case "INVALID_REF":
    case "STALE_PLAN":
    case "REFUSED":
    case "VERIFY_FAILED":
    case "SETTINGS":
      return code;
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

describe("ErrorCode", () => {
  it("is a closed enum every switch can exhaust", () => {
    expect(ErrorCode.options.map(codeName)).toEqual(ErrorCode.options);
    expect(ErrorCode.options).toHaveLength(15);
  });
});
