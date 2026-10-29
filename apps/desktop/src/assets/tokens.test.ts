// The guard that keeps tokens.css the only place a colour is decided: a literal in a component fails the
// suite, naming the line. A token file alone doesn't stop drift; the old app reached 17 alphas of one grey.
import { describe, expect, it } from "vitest";
import { appCss, components, styles } from "./styleSources.ts";
import tokens from "./tokens.css?raw";

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\([\d\s.,%/]+\)|\bhsla?\([\d\s.,%/]+\)/g;
const sheets = (): [string, string][] => [...components().map(([path, source]): [string, string] => [path, styles(source)]), ["assets/app.css", appCss.replace(/\/\*.*?\*\//gs, "")]];

describe("UI-53: colour lives in tokens.css and nowhere else", () => {
  it("is actually reading the app", () => {
    // Both checks below pass on an empty corpus, and ?raw on a stylesheet yields "" unless test.css is on.
    const paths = components().map(([path]) => path);
    expect(paths).toEqual(expect.arrayContaining(["components/StatusBanner.vue", "components/ToastStack.vue", "components/PageHeader.vue"]));
    expect(components().every(([, source]) => source.length > 0)).toBe(true);
    expect(tokens).toContain("--status-ok-ink");
    expect(appCss).toContain("button.btn-sm");
  });

  it("finds no colour literal in any component's styles or app.css", () => {
    const offences = sheets().flatMap(([path, css]) =>
      css.split("\n").flatMap((line) => (line.match(LITERAL) ?? []).map((literal) => `${path}: ${literal} in "${line.trim()}"`)),
    );
    expect(offences).toEqual([]);
  });

  it("declares every token a stylesheet asks for", () => {
    // A var() naming a missing token resolves to nothing and the property is silently dropped.
    const declared = new Set([...tokens.matchAll(/^\s*(--[\w-]+):/gm)].map(([, name]) => name));
    // Set per element by the component that reads it, not a theme value.
    declared.add("--catalog-hue");
    const missing = sheets().flatMap(([path, css]) => [...css.matchAll(/var\((--[\w-]+)/g)].filter(([, name]) => !declared.has(name)).map(([, name]) => `${path}: ${name}`));
    expect(missing).toEqual([]);
  });
});
