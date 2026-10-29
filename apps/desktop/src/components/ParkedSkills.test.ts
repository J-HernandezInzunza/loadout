import type { Library, Result } from "@loadout/core";
import { flushPromises } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App.vue";
import { mountView } from "../testing/mountView.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value, warnings: [] });
const skills = "/Users/dev/.claude/skills";
const item = (name: string, occupied = false) => ({ name, from: `${skills}-disabled/${name}`, to: `${skills}/${name}`, occupied });
const plan = { items: [item("grilling"), item("triage-bug"), item("library", true)] };

beforeEach(() => mockIPC(() => null));
afterEach(() => clearMocks());

function mountApp(library: Partial<Library> = {}) {
  const calls: unknown[][] = [];
  const mounted = mountView(App, {
    library: {
      planMigrateParked: async () => (calls.push(["planMigrateParked"]), ok(plan as never)),
      list: async () => (calls.push(["list"]), ok([])),
      ...library,
    },
  });
  return { ...mounted, calls };
}

type Wrapper = ReturnType<typeof mountApp>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};
const text = (w: Wrapper, selector: string) => w.findAll(selector).map((e) => e.text().replace(/\s+/g, " "));

describe("parked skills: what the Python CLI moved to skills-disabled", () => {
  it("lists every parked copy before the list, saying which stay because their place is taken", async () => {
    const { wrapper } = mountApp();
    await flushPromises();
    expect(wrapper.find(".page-title__heading").text()).toBe("Skills the Python CLI turned off");
    expect(wrapper.find(".entry-list").exists()).toBe(false);
    expect(text(wrapper, ".parked__items li")).toEqual(["grilling", "triage-bug", `library — stays parked: ${skills}/library is already taken`]);
    expect(wrapper.findAll("button").map((b) => b.text())).toContain("Move 2 back and keep them off");
  });

  it("moves them back on the user's word, reports what moved and what stayed, then reloads and goes on to the list", async () => {
    const applied: unknown[] = [];
    const { wrapper, calls } = mountApp({
      applyMigrateParked: async (p) => (applied.push(p), ok({ moved: ["grilling"], leftInPlace: [{ name: "triage-bug", reason: `${skills}/triage-bug is already taken` }] })),
    });
    await flushPromises();
    expect(applied).toEqual([]);
    const listed = calls.filter(([op]) => op === "list").length;
    await press(wrapper, "Move 2 back and keep them off");
    expect(applied).toEqual([plan]);
    expect(text(wrapper, ".parked__moved")).toEqual(["Moved back and kept off: grilling"]);
    expect(text(wrapper, ".parked__left li")).toEqual([`triage-bug — ${skills}/triage-bug is already taken`]);
    expect(calls.filter(([op]) => op === "list").length).toBe(listed + 1);

    await press(wrapper, "Continue");
    expect(wrapper.find(".parked").exists()).toBe(false);
    expect(wrapper.findAll("button").some((b) => b.text() === "Refresh")).toBe(true);
  });

  it("says nothing moved when the settings can't take the overrides, and still lets the user go on", async () => {
    const { wrapper } = mountApp({
      applyMigrateParked: async () => ({ ok: false, error: { code: "SETTINGS", message: "~/.claude/settings.json is not valid JSON" }, warnings: [] }),
    });
    await flushPromises();
    await press(wrapper, "Move 2 back and keep them off");
    expect(wrapper.find(".parked").text()).toContain("Nothing was moved.");
    expect(wrapper.find(".parked").text()).toContain("~/.claude/settings.json is not valid JSON");
    await press(wrapper, "Continue");
    expect(wrapper.find(".parked").exists()).toBe(false);
  });

  it("words a single copy as one", async () => {
    const { wrapper } = mountApp({ planMigrateParked: async () => ok({ items: [item("grilling")] } as never) });
    await flushPromises();
    expect(wrapper.findAll("button").map((b) => b.text())).toContain("Move it back and keep it off");
  });

  it("stays out of the way when nothing is parked, or nothing parked can move", async () => {
    for (const items of [[], [item("library", true)]]) {
      const { wrapper } = mountApp({ planMigrateParked: async () => ok({ items } as never) });
      await flushPromises();
      expect(wrapper.find(".parked").exists()).toBe(false);
    }
  });

  it("comes after first run when nothing is registered either", async () => {
    const { wrapper } = mountApp({ launch: async () => ok({ state: "no-catalogs" as const, catalogs: [] }), planImport: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "no Python CLI" }, warnings: [] }) });
    await flushPromises();
    expect(wrapper.find(".first-run").exists()).toBe(true);
    expect(wrapper.find(".parked").exists()).toBe(false);
  });
});
