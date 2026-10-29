// Every method of the Library interface has an exported input and output schema in `ops`, and `ops`
// describes nothing the interface lacks (architecture.md §8.2: tool definitions are generated).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ops } from "./schemas.ts";

/** Method names of `interface Library` in the source text. */
function libraryMethods(code: string): string[] {
  const file = ts.createSourceFile("library.ts", code, ts.ScriptTarget.Latest, true);
  const iface = file.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "Library");
  if (!iface) throw new Error("no interface Library");
  return iface.members.filter(ts.isMethodSignature).map((m) => m.name.getText(file));
}

/** `<method>: input|output` for each schema missing or not a zod schema, and `<op>: not on Library` for extras. */
function contractGaps(methods: string[], schemas: Record<string, { input?: unknown; output?: unknown }>): string[] {
  const gaps = methods.flatMap((m) =>
    (["input", "output"] as const).filter((k) => !(schemas[m]?.[k] instanceof z.ZodType)).map((k) => `${m}: ${k}`),
  );
  return [...gaps, ...Object.keys(schemas).filter((op) => !methods.includes(op)).map((op) => `${op}: not on Library`)];
}

const methods = libraryMethods(readFileSync(fileURLToPath(new URL("./library.ts", import.meta.url)), "utf8"));

describe("facade contract", () => {
  it("reads every method of the Library interface", () => {
    expect(methods).toEqual(expect.arrayContaining(["list", "applyInstall", "pins", "connect", "applyCatalogEdit", "suggestSource"]));
  });

  it("every Library method has an input and an output schema, and ops has nothing else", () => {
    expect(contractGaps(methods, ops)).toEqual([]);
  });

  it.each(methods)("dropping %s's input or output schema is caught", (m) => {
    const table: Record<string, { input?: unknown; output?: unknown }> = ops;
    for (const k of ["input", "output"] as const) {
      expect(contractGaps(methods, { ...table, [m]: { ...table[m], [k]: undefined } })).toEqual([`${m}: ${k}`]);
    }
    const without = Object.fromEntries(Object.entries(table).filter(([op]) => op !== m));
    expect(contractGaps(methods, without)).toEqual([`${m}: input`, `${m}: output`]);
  });
});
