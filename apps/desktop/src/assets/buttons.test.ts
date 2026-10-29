// The guard that keeps button geometry on app.css's scale (button, .btn-sm, .btn-xs): a size declared
// anywhere else fails, named, with the class to use. The old app reached eleven sizes for three jobs.
import { describe, expect, it } from "vitest";
import { appCss, components, styles } from "./styleSources.ts";

const SIZING = /^\s*(padding|font-size|border-radius)\b/;

/** Selectors allowed to size a button, by `path: selector`, each because it is not a button-shaped button. */
const ALLOWED = new Set([
  // The log's own bar: its height is locked to the strip it opens, so padding is horizontal only.
  "components/CommandLog.vue: .command-log__toggle",
  "components/CommandLog.vue: .command-log__more",
  // Icon buttons, sized by their icon.
  "components/AppearanceToggle.vue: .appearance-toggle",
  "components/ToastStack.vue: .toasts__close",
]);

/** Selectors allowed to draw a disabled button themselves, each with the reason app.css's rule is wrong for it. */
const ALLOWED_DISABLED = new Set<string>([]);
const DISABLED_STATE = /^\s*(opacity|cursor)\b/;

/**
 * The classes a file puts on a `<button>`, static and bound (the object syntax's keys). Deliberately
 * generous: a false positive gets read and allowlisted, a miss is a silent hole.
 */
export function buttonClasses(source: string): Set<string> {
  const template = source.split("<style")[0]!;
  const found = new Set<string>();
  for (const [tag] of template.matchAll(/<button\b[^>]*>/gs)) {
    for (const [, value] of tag.matchAll(/(?<!:)\bclass="([^"]*)"/g)) for (const name of value!.split(/\s+/).filter(Boolean)) found.add(name);
    for (const [, value] of tag.matchAll(/:class="([^"]*)"/gs)) for (const [, name] of value!.matchAll(/['"]?([\w-]+)['"]?\s*:/g)) found.add(name!);
  }
  return found;
}

function targetsButton(selector: string, classes: Set<string>): boolean {
  if (/(^|[\s>+~(])button\b/.test(selector)) return true;
  return [...classes].some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(selector));
}

/** `:not(:disabled)` is stripped first: hover and active rules about the enabled state name the word too. */
function targetsDisabled(selector: string): boolean {
  return selector.replace(/:not\([^)]*\)/g, "").includes(":disabled");
}

/** Every `selector { declaration }` pair aimed at a button and matching `property`, by `path: selector`. */
function buttonDeclarations(property: RegExp, only: (selector: string) => boolean): [string, string][] {
  return components().flatMap(([path, source]) => {
    const classes = buttonClasses(source);
    return [...styles(source).matchAll(/([^{}]+)\{([^{}]*)\}/gs)].flatMap(([, selectors, body]) =>
      selectors!
        .split(",")
        .map((s) => s.trim().replace(/\s+/g, " "))
        .filter((s) => s && targetsButton(s, classes) && only(s))
        .flatMap((s) => body!.split(";").filter((d) => property.test(d)).map((d): [string, string] => [`${path}: ${s}`, d.trim()])),
    );
  });
}

describe("UI-09: button geometry lives on one scale", () => {
  it("is actually reading the app and the scale", () => {
    expect(components().map(([path]) => path)).toEqual(expect.arrayContaining(["components/ToastStack.vue", "components/AppearanceToggle.vue"]));
    for (const rule of ["button {", "button.btn-sm", "button.btn-xs", "button.ghost", "button.danger", "button:disabled"]) expect(appCss).toContain(rule);
    expect(appCss).toMatch(/button:disabled\s*\{[^}]*opacity:\s*0\.45/);
  });

  it("finds no button sized outside the scale", () => {
    const offences = buttonDeclarations(SIZING, () => true)
      .filter(([where]) => !ALLOWED.has(where))
      .map(([where, d]) => `${where} sets "${d}"; use .btn-sm or .btn-xs, or add it to ALLOWED with the reason it is not a button-shaped button`);
    expect(offences).toEqual([]);
  });

  it("finds no button drawing its own disabled state", () => {
    const offences = buttonDeclarations(DISABLED_STATE, targetsDisabled)
      .filter(([where]) => !ALLOWED_DISABLED.has(where))
      .map(([where, d]) => `${where} sets "${d}"; app.css's button:disabled already draws this`);
    expect(offences).toEqual([]);
  });

  it("sees the classes, static and bound, that a template puts on its buttons", () => {
    const source = `<button class="ghost btn-sm" :class="{ 'x__on': on, y: !on }">a</button><style>.z{}</style>`;
    expect([...buttonClasses(source)].sort()).toEqual(["btn-sm", "ghost", "x__on", "y"]);
    expect(buttonClasses(components().find(([p]) => p === "components/ToastStack.vue")![1])).toContain("toasts__close");
    expect(targetsDisabled("button:disabled")).toBe(true);
    expect(targetsDisabled("button:active:not(:disabled)")).toBe(false);
  });
});
