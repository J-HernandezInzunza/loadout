import type { Library } from "@loadout/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import DoctorView from "./DoctorView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
type Report = Extract<Awaited<ReturnType<Library["doctor"]>>, { ok: true }>["value"];
const finding = (extra: Partial<Report["errors"][number]>): Report["errors"][number] => ({ check: "8", severity: "error", catalog: "team", entry: null, message: "m", ...extra });

async function mountDoctor(reports: Report[], library: Partial<Library> = {}) {
  const calls: unknown[][] = [];
  let runs = 0;
  const mounted = mountView(DoctorView, {
    props: { back: "Catalogs" },
    library: {
      doctor: async (o) => (calls.push(["doctor", o?.deep ?? false]), ok(reports[Math.min(runs++, reports.length - 1)]!)),
      recloneCatalog: async (id) => (calls.push(["reclone", id]), ok(undefined)),
      ...library,
    },
  });
  await flushPromises();
  return { ...mounted, calls };
}

describe("UI-39: doctor", () => {
  afterEach(() => clearMocks());

  it("starts its report with the running build's version", async () => {
    mockIPC((cmd) => (cmd === "plugin:app|version" ? "0.1.0" : undefined));
    const { wrapper } = await mountDoctor([{ status: "ok", entries: 1, errors: [], warnings: [] }]);
    const lines = wrapper.findAll(".doctor__version, .doctor__summary").map((p) => p.text().replace(/\s+/g, " "));
    expect(lines).toEqual(["Loadout 0.1.0", "1 entries · 0 errors · 0 warnings"]);
  });

  it("checks on open and says so when there is nothing to report", async () => {
    const { wrapper, calls } = await mountDoctor([{ status: "ok", entries: 12, errors: [], warnings: [] }]);
    expect(calls).toEqual([["doctor", false]]);
    expect(wrapper.find(".page-title__heading").text()).toBe("Catalog health");
    expect(wrapper.find(".view__head button").text()).toBe("← Catalogs");
    expect(wrapper.find(".doctor__summary").text().replace(/\s+/g, " ")).toBe("12 entries · 0 errors · 0 warnings");
    expect(wrapper.find(".doctor__clean").text()).toBe("Nothing to report.");
  });

  it("lists errors and warnings, each prefixed by its entry, else its catalog", async () => {
    const { wrapper } = await mountDoctor([
      { status: "problems", entries: 3, errors: [finding({ entry: "tidy", message: "requires skill:gone, which no catalog defines" })], warnings: [finding({ severity: "warning", message: "clone is 2 commits behind" })] },
    ]);
    expect(wrapper.findAll(".doctor__section").map((h) => h.text())).toEqual(["Errors", "Warnings"]);
    expect(wrapper.findAll(".doctor__item").map((i) => [i.find(".doctor__subject").text(), i.find(".doctor__message").text()])).toEqual([
      ["tidy", "requires skill:gone, which no catalog defines"],
      ["team", "clone is 2 commits behind"],
    ]);
  });

  it("re-runs deep from its checkbox, which is disabled while a run is going", async () => {
    let finish = () => {};
    const { wrapper, calls } = await mountDoctor([{ status: "ok", entries: 1, errors: [], warnings: [] }]);
    const deep = wrapper.find(".doctor__deep input");
    await deep.setValue(true);
    expect(calls).toEqual([["doctor", false], ["doctor", true]]);

    const slow = await mountDoctor([], { doctor: () => new Promise((resolve) => (finish = () => resolve(ok({ status: "ok" as const, entries: 1, errors: [], warnings: [] })))) });
    expect(slow.wrapper.find(".doctor__deep input").attributes("disabled")).toBeDefined();
    finish();
    await flushPromises();
    expect(slow.wrapper.find(".doctor__deep input").attributes("disabled")).toBeUndefined();
  });

  it("offers a re-clone for a diverged clone, then checks again", async () => {
    const diverged = finding({ check: "A4", message: "the clone of team has diverged from origin", action: { kind: "reclone", catalog: "team" } });
    const { wrapper, calls } = await mountDoctor([
      { status: "problems", entries: 1, errors: [diverged], warnings: [] },
      { status: "ok", entries: 1, errors: [], warnings: [] },
    ]);
    await wrapper.findAll("button").find((b) => b.text() === "Re-clone team")!.trigger("click");
    await flushPromises();
    expect(calls).toEqual([["doctor", false], ["reclone", "team"], ["doctor", false]]);
    expect(wrapper.find(".doctor__clean").exists()).toBe(true);
  });
});

describe("doctor: content Loadout didn't install (Q8 A)", () => {
  it("offers the catalog's copy on an unmanaged finding only, over on the install page that asks first", async () => {
    const dest = "/Users/dev/.claude/skills/tidy";
    const { wrapper } = await mountDoctor([
      {
        status: "problems",
        entries: 2,
        errors: [],
        warnings: [
          finding({ check: "30", severity: "warning", catalog: null, entry: "tidy", message: `${dest} wasn't installed by Loadout (foreign)`, action: { kind: "replace", name: "tidy", dest } }),
          finding({ check: "29", severity: "warning", entry: "lint", message: "has local edits" }),
        ],
      },
    ]);
    const views = useViewStore();
    views.manage = { catalog: null, entry: null };
    views.doctor = true;
    expect(wrapper.findAll(".doctor__item").map((li) => li.findAll("button").map((b) => b.text()))).toEqual([["Replace with the catalog's copy"], []]);
    await wrapper.find(".doctor__item button").trigger("click");
    expect(views.current).toEqual({ kind: "install", name: "tidy" });
  });
});
