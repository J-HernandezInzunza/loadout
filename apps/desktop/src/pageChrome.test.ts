// The shared page chrome, guarded against the source: the defects it catches only exist between screens,
// as a control that jumps when you navigate, which no single-component test can see.
import { describe, expect, it } from "vitest";
import { appCss, components } from "./assets/styleSources.ts";

const source = (name: string) => components().find(([path]) => path === name || path.endsWith(`/${name}`))?.[1] ?? "";

describe("UI-09, UI-55: page chrome", () => {
  it("leaves PageHeader the only component drawing a back arrow", () => {
    expect(source("PageHeader.vue")).toContain("←");
    const offenders = components()
      .filter(([path, src]) => !path.endsWith("/PageHeader.vue") && src.includes("←"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("scrolls one surface inside the view, never the document, and reserves the scrollbar's width", () => {
    expect(appCss).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
    expect(appCss).toMatch(/\.view__body\s*\{[^}]*overflow-y:\s*auto/);
    expect(appCss).toMatch(/\.view__body\s*\{[^}]*overscroll-behavior:\s*contain/);
    expect(appCss).toMatch(/\.view__body\s*\{[^}]*scrollbar-gutter:\s*stable/);
    expect(appCss).toMatch(/\.column\s*\{[^}]*padding-inline:\s*max\(1\.25rem, calc\(\(100% - 860px\) \/ 2\)\)/);
  });

  it("frames a view as a head row, one scrolling body and a foot", () => {
    expect(appCss).toMatch(/\.view\s*\{[^}]*grid-template-rows:\s*auto 1fr auto/);
    const header = source("PageHeader.vue");
    expect(header.indexOf('class="page-head view__head')).toBeLessThan(header.indexOf('class="view__body'));
    expect(header.indexOf('class="view__body')).toBeLessThan(header.indexOf('class="page-title"'));
  });

  it("makes the app the view, then the command bar, so the bar is the window's bottom by construction", () => {
    const app = source("App.vue");
    expect(app).toMatch(/\.app\s*\{[^}]*grid-template-rows:\s*1fr auto/);
    expect(app).toMatch(/<section[^>]*class="view"/);
    expect(app).not.toMatch(/position:\s*(fixed|sticky)/);
  });

  it("keeps the command bar in the flow, and its panel an overlay that never resizes the view", () => {
    const log = source("CommandLog.vue");
    expect(log).not.toMatch(/\.command-log\s*\{[^}]*position:\s*fixed/);
    expect(log).toMatch(/\.command-log__list\s*\{[^}]*position:\s*absolute/);
    expect(log).toMatch(/\.command-log__list\s*\{[^}]*bottom:\s*100%/);
    expect(source("App.vue")).toContain("<CommandLog />");
  });

  it("leaves the scrolling body full width, so nothing is clipped against its edge", () => {
    // A max-width on the scroller clips focus rings drawn outside an input stretched to it.
    const offenders = components()
      .filter(([, src]) => /\.view__body\s*\{[^}]*max-width/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
    expect(appCss).not.toMatch(/\.view__body\s*\{[^}]*max-width/);
  });
});
