import type { Library, PlanItem } from "@loadout/core";
import { catalogRow, entryRecord, installedRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { mountView } from "../testing/mountView.ts";
import CatalogView from "./CatalogView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });

function item(name: string, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    type: "skill",
    name,
    catalog: "personal",
    dest: `/Users/dev/.claude/skills/${name}`,
    requiredBy: [],
    state: "absent",
    needsConsent: false,
    status: "ready",
    preview: { kind: "files", newInstall: true, added: [], removed: [], modified: [], editedLocally: [] },
    ...extra,
  } as PlanItem;
}

const catalogs = [catalogRow({ id: "personal" }), catalogRow({ id: "team", precedence: 2 })];
const entries = [
  entryRecord({ name: "alpha" }),
  installedRecord("installed", { name: "beta" }),
  entryRecord({ name: "gamma" }),
  entryRecord({ name: "alpha", catalog: "team", overriddenBy: "personal" }),
];

async function mountList(library: Partial<Library> = {}, seed = { catalogs, entries }) {
  const calls: unknown[][] = [];
  const mounted = mountView(CatalogView, {
    seed,
    library: {
      planInstall: async (req) => (calls.push(["planInstall", req.names]), ok({ items: req.names.map((n) => item(n)), opDir: "/tmp/op", fingerprint: "f" } as never)),
      applyInstall: async (plan) => (calls.push(["applyInstall"]), ok({ installed: plan.items.map((i) => ({ type: i.type, name: i.name, dest: i.dest, preview: i.preview })), stopped: null, aborted: false })),
      discardPlan: async () => (calls.push(["discardPlan"]), ok(undefined)),
      uninstall: async (req) => (calls.push(["uninstall", req]), ok({ items: req.names.map((name) => ({ type: "skill" as const, name, dest: `/d/${name}`, outcome: "deleted" as const, overrideRemoved: null })) })),
      ...library,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountList>>["wrapper"];
const button = (w: Wrapper, text: string) => w.findAll("button").find((b) => b.text() === text);
const press = async (w: Wrapper, text: string) => {
  await button(w, text)!.trigger("click");
  await flushPromises();
};
const openTab = async (w: Wrapper, id: string) => {
  await w.find(".toolbar__from select").setValue(id);
  await flushPromises();
};
const pick = async (w: Wrapper, name: string) => {
  await w.find(`[aria-label='Select ${name}']`).trigger("click");
  await flushPromises();
};

describe("UI-21: selection in a catalog tab", () => {
  it("is offered only in a catalog tab, and opening a tab doesn't start it", async () => {
    const { wrapper } = await mountList();
    expect(button(wrapper, "Install or remove several")).toBeUndefined();
    await openTab(wrapper, "personal");
    expect(button(wrapper, "Install or remove several")).toBeDefined();
    expect(button(wrapper, "Stop selecting")).toBeUndefined();
    expect(wrapper.find(".entry-list__tick").exists()).toBe(false);
  });

  it("turns cards into pick targets, with Select all, Clear and Stop selecting; switches hide while picking", async () => {
    const { wrapper } = await mountList();
    await openTab(wrapper, "personal");
    expect(wrapper.find("[role=switch]").exists()).toBe(true);
    await press(wrapper, "Install or remove several");
    expect(wrapper.find("[role=switch]").exists()).toBe(false);
    expect(wrapper.find(".bulk__count").text()).toContain("Act on several at once");

    await pick(wrapper, "alpha");
    expect(wrapper.find("[aria-label='Select alpha']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.find(".bulk__count").text()).toBe("1 selected from personal");
    await press(wrapper, "Select all 3");
    expect(wrapper.find(".bulk__count").text()).toBe("3 selected from personal");
    expect(button(wrapper, "Select all 3")).toBeUndefined();
    await press(wrapper, "Clear");
    expect(wrapper.find(".bulk__count").text()).toContain("Act on several at once");
    await press(wrapper, "Stop selecting");
    expect(wrapper.find(".bulk").exists()).toBe(false);
  });

  it("selects from the search-filtered rows, and changing tabs leaves selection mode", async () => {
    const { wrapper } = await mountList();
    await openTab(wrapper, "personal");
    await press(wrapper, "Install or remove several");
    await wrapper.find("input[type=search]").setValue("gam");
    await press(wrapper, "Select all 1");
    expect(wrapper.find(".bulk__count").text()).toBe("1 selected from personal");
    await openTab(wrapper, "team");
    expect(wrapper.find(".bulk").exists()).toBe(false);
  });

  it("explains a tab where every copy is overridden instead of hiding the control", async () => {
    const { wrapper } = await mountList();
    await openTab(wrapper, "team");
    expect(wrapper.find(".summary__note").text()).toContain("Nothing here can be installed");
    expect(button(wrapper, "Install or remove several")).toBeUndefined();
  });
});

describe("UI-37: the bulk panel", () => {
  async function selecting(library: Partial<Library> = {}) {
    const mounted = await mountList(library);
    await openTab(mounted.wrapper, "personal");
    await press(mounted.wrapper, "Install or remove several");
    return mounted;
  }

  it("plans the whole selection as one install, counting the dependencies nobody ticked", async () => {
    const { wrapper, calls } = await selecting({
      planInstall: async (req) => ok({ items: [item("lint", { requiredBy: ["alpha"] }), ...req.names.map((n) => item(n))], opDir: "/tmp/op", fingerprint: "f" } as never),
    });
    await pick(wrapper, "alpha");
    await pick(wrapper, "gamma");
    await press(wrapper, "Preview install");
    expect(calls).toEqual([]);
    expect(wrapper.find(".bulk__scope").text().replace(/\s+/g, " ")).toBe("nothing has been written · 3 destinations (1 pulled in as dependencies)");
    expect(wrapper.find(".bulk__role").text()).toBe("dependency");
    expect(button(wrapper, "Install 3")).toBeDefined();
  });

  it("holds one acknowledgement over every drifted copy", async () => {
    const { wrapper } = await selecting({
      planInstall: async (req) => ok({ items: req.names.map((n) => item(n, { state: "drifted" })), opDir: "/tmp/op", fingerprint: "f" } as never),
    });
    await press(wrapper, "Select all 3");
    await press(wrapper, "Preview install");
    expect(wrapper.find(".bulk__warning").text()).toContain("3 of these have local edits Loadout did not make.");
    expect(wrapper.findAll(".bulk__ack")).toHaveLength(1);
    expect(button(wrapper, "Install 3")!.attributes("disabled")).toBeDefined();
    await wrapper.find(".bulk__ack input").setValue(true);
    expect(button(wrapper, "Install 3")!.attributes("disabled")).toBeUndefined();
  });

  it("installs, reports what landed, and stays in selection mode with the selection cleared", async () => {
    const { wrapper, calls } = await selecting({
      planInstall: async (req) => ok({ items: [item("lint", { requiredBy: ["alpha"] }), ...req.names.map((n) => item(n))], opDir: "/tmp/op", fingerprint: "f" } as never),
    });
    await pick(wrapper, "alpha");
    await press(wrapper, "Preview install");
    await press(wrapper, "Install 2");
    expect(calls).toContainEqual(["applyInstall"]);
    expect(wrapper.find(".bulk__done").text().replace(/\s+/g, " ")).toBe("Installed 1 entry from personal, with 1 dependency.");
    expect(wrapper.find(".bulk__count").text()).toContain("Act on several at once");
  });

  it("confirms before removing, naming the count, and removes unforced", async () => {
    const { wrapper, calls } = await selecting();
    await pick(wrapper, "alpha");
    await pick(wrapper, "beta");
    await press(wrapper, "Uninstall");
    expect(wrapper.find(".bulk__confirm-q").text().replace(/\s+/g, " ")).toBe("Remove the global copies of 2 selected entries?");
    expect(calls.filter((c) => c[0] === "uninstall")).toEqual([]);
    await press(wrapper, "Remove 2");
    expect(calls).toContainEqual(["uninstall", { names: ["alpha", "beta"] }]);
    expect(wrapper.find(".status-banner--success").text()).toContain("Removed 2 entries from this machine.");
  });

  it("says nothing was installed rather than claiming a removal, and warns about a refused copy", async () => {
    const absent = await selecting({ uninstall: async () => ok({ items: [{ type: "skill" as const, name: "alpha", dest: "/d", outcome: "absent" as const, overrideRemoved: null }] }) });
    await pick(absent.wrapper, "alpha");
    await press(absent.wrapper, "Uninstall");
    await press(absent.wrapper, "Remove 1");
    expect(absent.wrapper.text()).toContain("None of the selected entries were installed — nothing to remove.");

    const refused = await selecting({
      uninstall: async () =>
        ok({
          items: [
            { type: "skill" as const, name: "alpha", dest: "/d/a", outcome: "deleted" as const, overrideRemoved: null },
            { type: "skill" as const, name: "beta", dest: "/d/b", outcome: "refused" as const, overrideRemoved: null },
          ],
        }),
    });
    await pick(refused.wrapper, "alpha");
    await pick(refused.wrapper, "beta");
    await press(refused.wrapper, "Uninstall");
    await press(refused.wrapper, "Remove 2");
    const banner = refused.wrapper.find(".status-banner--warning").text().replace(/\s+/g, " ");
    expect(banner).toContain("Removed 1 entry from this machine.");
    expect(banner).toContain("1 entry was left in place because Loadout has no record of installing it: beta.");
  });

  it("drops a pending confirmation and an unapplied plan when the selection changes", async () => {
    const { wrapper, calls } = await selecting();
    await pick(wrapper, "alpha");
    await press(wrapper, "Uninstall");
    await pick(wrapper, "gamma");
    expect(wrapper.find(".bulk__confirm").exists()).toBe(false);

    await press(wrapper, "Preview install");
    await pick(wrapper, "beta");
    expect(wrapper.find(".bulk__plan").exists()).toBe(false);
    expect(calls.at(-1)).toEqual(["discardPlan"]);
  });
});
