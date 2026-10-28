import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expected, goldenSchemas, loadGolden, materializeTree, replaySplice, type SpliceImpl } from "./golden.ts";
import { createSandbox } from "./sandbox.ts";

describe("golden fixtures", () => {
  it("load the splice corpus through its schema", () => {
    const { texts, cases } = loadGolden("splice");
    expect(Object.keys(texts)).toHaveLength(29);
    expect(cases).toHaveLength(896);
    expect(cases.filter((c) => c.rebuild)).toHaveLength(269);
  });

  it("load the scalar corpus through its schema", () => {
    const { cases } = loadGolden("scalar");
    expect(cases).toHaveLength(4693);
    expect(cases.filter((c) => "multiline" in c)).toHaveLength(4);
  });

  it("load the source corpus through its schema", () => {
    const { meta, parseSource, remoteWeb } = loadGolden("source");
    expect(meta.home).toBe("/home/golden");
    expect(parseSource).toHaveLength(33);
    expect(remoteWeb).toHaveLength(14);
  });

  it("load the hash, registry and read corpora through their schemas", () => {
    expect(loadGolden("hash").cases).toHaveLength(20);
    expect(loadGolden("registry").cases).toHaveLength(31);
    expect(loadGolden("read").cases).toHaveLength(66);
  });

  it("reject a fixture shape the schemas do not know", () => {
    const hash = loadGolden("hash");
    expect(goldenSchemas.hash.safeParse({ ...hash, extra: 1 }).success).toBe(false);
    const pipe = { ...hash.cases[0]!, nodes: [{ path: "p", type: "pipe" }] };
    expect(goldenSchemas.hash.safeParse({ ...hash, cases: [pipe] }).success).toBe(false);
  });
});

describe("expected", () => {
  const { cases } = loadGolden("splice");

  it("prefers the rebuild expectation over python's", () => {
    const c = cases.find((c) => c.rebuild)!;
    expect(expected(c)).toBe(c.rebuild);
  });

  it("falls back to python's when there is no rebuild expectation", () => {
    const c = cases.find((c) => !c.rebuild)!;
    expect(expected(c)).toBe(c.python);
  });
});

describe("replaySplice", () => {
  const fixture = loadGolden("splice");
  const byId = (id: string) => fixture.cases.find((c) => c.id === id)!;
  // Each op appends a marker, so the result shows which ops ran, in which order, on which text.
  const tracer: SpliceImpl = {
    renderEntry: (e) => [`render ${e.name}`],
    spliceEntry: (text, e) => `${text}+${e.type}:${e.name}`,
    removeEntry: (text, type, name) => `${text}-${type}:${name}`,
    replaceEntry: (text, type, name, e) => `${text}~${type}:${name}>${e.name}`,
  };

  it("applies a batch in order, starting from the case's text", () => {
    const c = byId("py-catalog/skills/insert-batch");
    const marks = c.ops.map((o) => (o.op === "splice" ? `+${o.entry.type}:${o.entry.name}` : "?")).join("");
    expect(replaySplice(fixture, c, tracer)).toEqual({ text: fixture.texts["py-catalog"]!.text + marks });
  });

  it("returns a render case's lines", () => {
    const c = fixture.cases.find((c) => c.text === null)!;
    const op = c.ops[0]!;
    if (op.op !== "render") throw new Error(`${c.id} is not a render case`);
    expect(replaySplice(fixture, c, tracer)).toEqual({ lines: [`render ${op.entry.name}`] });
  });

  it("returns a thrown error's code, message and line", () => {
    const c = byId("py-catalog/skills/insert-batch");
    const failing: SpliceImpl = {
      ...tracer,
      spliceEntry: () => {
        throw Object.assign(new Error("line 2: nope"), { code: "SPLICE_UNSUPPORTED", line: 2 });
      },
    };
    expect(replaySplice(fixture, c, failing)).toEqual({ error: { code: "SPLICE_UNSUPPORTED", message: "line 2: nope", line: 2 } });
    const plain: SpliceImpl = { ...tracer, spliceEntry: () => { throw new Error("'x' not found in skills"); } };
    expect(replaySplice(fixture, c, plain)).toEqual({ error: { message: "'x' not found in skills" } });
  });
});

describe("materializeTree", () => {
  it("writes every hash case's nodes and returns the path to hash", async () => {
    const sb = await createSandbox();
    for (const c of loadGolden("hash").cases) {
      const dir = join(sb.root, c.id);
      expect(await materializeTree(dir, c)).toBe(join(dir, c.hash));
      for (const n of c.nodes) {
        const p = join(dir, n.path);
        const kind = await lstat(p);
        if (n.type === "dir") expect(kind.isDirectory()).toBe(true);
        else if (n.type === "symlink") expect(await readlink(p)).toBe(n.target);
        else if ("text" in n) expect(await readFile(p, "utf8")).toBe(n.text);
        else expect((await readFile(p)).toString("base64")).toBe(n.base64);
      }
    }
  });
});
