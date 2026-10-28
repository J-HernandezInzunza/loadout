// Every rule id of a checked task in docs/PLAN.md must appear in the title of some describe/it/test
// under packages/ and test/ (PLAN.md, "How the loop uses this file").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const plan = readFileSync(join(repoRoot, "docs/PLAN.md"), "utf8");
const ruleId = /\b[A-Z]+-\d{2}\b/g;
const testFunctions = new Set(["describe", "it", "test"]);
const skipDirs = new Set(["node_modules", "dist", "target"]);

/** Rule ids per checked task, keyed by task id. */
function checkedRules(text: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  let task: string | undefined;
  for (const line of text.split("\n")) {
    const head = /^- \[([ xX])\] \*\*(M\d+\.\d+)\b/.exec(line);
    if (head) task = head[1] === " " ? undefined : head[2];
    else if (!line.startsWith(" ")) task = undefined;
    else if (task && /^\s+- Rules:/.test(line)) rules.set(task, line.match(ruleId) ?? []);
  }
  return rules;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.isDirectory()) return skipDirs.has(d.name) ? [] : testFiles(join(dir, d.name));
    return d.name.endsWith(".test.ts") ? [join(dir, d.name)] : [];
  });
}

function rootName(e: ts.Expression): string | undefined {
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
}

/** First-argument text of every describe/it/test call, including the `.each(…)(title)` forms. */
function titles(code: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && testFunctions.has(rootName(node.expression) ?? "")) {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))) out.push(title.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.test.ts", code, ts.ScriptTarget.Latest, true));
  return out;
}

/** `<task>: <rule id>` for every rule of a checked task that no title mentions. */
function uncovered(text: string, allTitles: string[]): string[] {
  const covered = new Set(allTitles.flatMap((t) => t.match(ruleId) ?? []));
  return [...checkedRules(text)].flatMap(([task, ids]) => ids.filter((id) => !covered.has(id)).map((id) => `${task}: ${id}`));
}

const repoTitles = ["packages", "test"]
  .flatMap((d) => testFiles(join(repoRoot, d)))
  .flatMap((f) => titles(readFileSync(f, "utf8")));
const unchecked = plan.replace(/^- \[[xX]\]/gm, "- [ ]");
const tick = (text: string, task: string) => text.replace(`- [ ] **${task} `, `- [x] **${task} `);

describe("rule coverage", () => {
  it("finds a test title for every rule of every checked task", () => {
    expect(uncovered(plan, repoTitles)).toEqual([]);
  });

  it("passes while no task is checked", () => {
    expect(uncovered(unchecked, [])).toEqual([]);
  });

  it("fails when a checked task has a rule no title mentions", () => {
    const copy = tick(unchecked, "M1.05");
    expect(uncovered(copy, [])).toEqual(["M1.05: EDIT-02", "M1.05: EDIT-03"]);
    expect(uncovered(copy, ['"EDIT-02: quotes like PyYAML"'])).toEqual(["M1.05: EDIT-03"]);
  });

  it("reads a Rules line for every task in the plan", () => {
    const tasks = plan.match(/^- \[[ xX]\] \*\*M\d+\.\d+\b/gm) ?? [];
    const rules = checkedRules(plan.replace(/^- \[ \]/gm, "- [x]"));
    expect(tasks.length).toBeGreaterThan(50);
    expect(rules.size).toBe(tasks.length);
    expect(rules.get("M1.19")).toEqual(["RES-01", "RES-02", "RES-03", "RES-04", "RES-05", "RES-06", "RES-10", "RES-11"]);
  });

  it("takes titles from describe, it and test, including their each forms", () => {
    const code = `
      describe("A-01 group", () => {
        it.each([1, 2])("B-02 case %s", () => {});
        test(\`C-03 \${x}\`, () => {});
        describe.each(["Z-99 not a title"])("D-04 %s", () => {});
        expect("E-05").toBe("E-05");
      });`;
    expect(titles(code).flatMap((t) => t.match(ruleId) ?? [])).toEqual(["A-01", "B-02", "C-03", "D-04"]);
  });
});
