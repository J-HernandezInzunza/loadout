import type { CatalogRow, Library } from "@loadout/core";
import { catalogRow, entryRecord, installedRecord, pinRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import CatalogsView from "./CatalogsView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const team = catalogRow({ id: "team", precedence: 2, kind: "remote", writeMode: "pr", editable: true, location: "git@bitbucket.org:acme/catalog.git (main, library.yaml)" });
const personal = catalogRow();

async function mountCatalogs(catalogs: CatalogRow[] = [personal, team], extra: Partial<Library> = {}, at: string | null = null, pins = [pinRecord({ name: "deploy" })]) {
  const calls: unknown[][] = [];
  const mounted = mountView(CatalogsView, {
    seed: { catalogs, entries: [entryRecord({ name: "zeta" }), entryRecord({ name: "alpha" }), installedRecord("installed", { name: "tidy", catalog: "team" }), entryRecord({ name: "lint", catalog: "team" })], pins },
    props: { at, back: "Loadout" },
    library: {
      removeCatalog: async (req) => (calls.push(["removeCatalog", req]), ok({ purgedClone: !!req.purgeClone, purgedInstalls: req.purgeInstalls ? ["/Users/dev/.claude/skills/tidy"] : [], clearedReceipts: 0 })),
      unpin: async (name) => (calls.push(["unpin", name]), ok({ name, was: "team", resolvesTo: "personal" })),
      ...extra,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountCatalogs>>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};

describe("UI-41: the registry", () => {
  it("lists catalogs in precedence order, saying what each is and what writing costs, with Manage entries where Loadout writes", async () => {
    const { wrapper } = await mountCatalogs();
    expect(wrapper.find(".page-title__heading").text()).toBe("Catalogs");
    expect(wrapper.findAll(".page-title__actions button").map((b) => b.text())).toEqual(["Add a catalog", "Check catalog health"]);
    const rows = wrapper.findAll(".catalogs__row");
    expect(rows.map((r) => r.find(".catalogs__chip").text())).toEqual(["personal", "team"]);
    expect(rows[0]!.find(".catalogs__why").text()).toBe("Edits are saved straight to the file.");
    expect(rows[1]!.find(".catalogs__why").text()).toBe("Entries here are changed in the repository itself, where the change opens a pull request there, so it gets the same review as any other change.");
    expect(rows.map((r) => r.findAll("button").map((b) => b.text()))).toEqual([
      ["Manage entries", "Unregister"],
      ["Unregister"],
    ]);
  });

  it("offers a personal catalog when none is on this machine, and no Unregister for the only catalog", async () => {
    const { wrapper } = await mountCatalogs([catalogRow({ ...team, precedence: 1 })]);
    expect(wrapper.find(".catalogs__own-title").text()).toBe("You don't have a personal catalog yet");
    expect(wrapper.findAll(".catalogs__row button").map((b) => b.text())).toEqual([]);
    await press(wrapper, "Create a personal catalog");
    expect(wrapper.find(".page-title__heading").text()).toBe("Add a catalog");
    expect(wrapper.find("input[value=create]").element).toHaveProperty("checked", true);
  });

  it("opens Doctor and a catalog's entries from here", async () => {
    const { wrapper } = await mountCatalogs();
    await press(wrapper, "Check catalog health");
    expect(useViewStore().doctor).toBe(true);
    useViewStore().doctor = false;
    await press(wrapper, "Manage entries");
    expect(useViewStore().current).toEqual({ kind: "catalogs", catalog: "personal", entry: null });
  });
});

describe("UI-42: pinned names", () => {
  it("lists each pin, says when it can't supply the name, and clears it", async () => {
    const { wrapper, calls } = await mountCatalogs(undefined, {}, null, [pinRecord({ name: "deploy" }), pinRecord({ name: "gone", catalog: "team", dangling: true, resolvesTo: "personal" })]);
    expect(wrapper.find(".catalogs__pins-title").text()).toBe("Pinned names (2)");
    expect(wrapper.findAll(".catalogs__pin-dangling").map((d) => d.text().replace(/\s+/g, " "))).toEqual(["team can't supply this — it comes from personal instead"]);
    await wrapper.findAll(".catalogs__pin-clear")[0]!.trigger("click");
    await flushPromises();
    expect(calls).toEqual([["unpin", "deploy"]]);
  });
});

describe("UI-43: unregistering", () => {
  it("asks first, offers to delete the copies and the clone, and reports what it did", async () => {
    const { wrapper, calls } = await mountCatalogs();
    await wrapper.findAll(".catalogs__unregister")[1]!.trigger("click");
    expect(wrapper.find(".catalogs__question").text()).toBe("Stop reading from team?");
    const [installs, clone] = wrapper.findAll(".catalogs__purge input");
    expect(wrapper.find(".catalogs__purge").text()).toContain("— around 1");
    await installs!.setValue(true);
    await clone!.setValue(true);
    await press(wrapper, "Unregister and delete the copies");
    expect(calls).toEqual([["removeCatalog", { id: "team", purgeClone: true, purgeInstalls: true }]]);
    const done = wrapper.find(".status-banner--success").text().replace(/\s+/g, " ");
    expect(done).toContain("Unregistered team. Deleted 1 installed copy.");
    expect(done).toContain("Its clone was deleted.");
  });

  it("says plainly when nothing was attributable to it", async () => {
    const { wrapper } = await mountCatalogs(undefined, { removeCatalog: async () => ok({ purgedClone: false, purgedInstalls: [], clearedReceipts: 0 }) });
    await wrapper.findAll(".catalogs__unregister")[1]!.trigger("click");
    await wrapper.find(".catalogs__purge input").setValue(true);
    await press(wrapper, "Unregister and delete the copies");
    expect(wrapper.find(".status-banner--success").text()).toContain("No copies were deleted.");
  });

  it("ignores a second click while the first is running", async () => {
    let finish = () => {};
    const calls: unknown[] = [];
    const { wrapper } = await mountCatalogs(undefined, {
      removeCatalog: (req) => (calls.push(req), new Promise((resolve) => (finish = () => resolve(ok({ purgedClone: false, purgedInstalls: [], clearedReceipts: 0 }))))),
    });
    await wrapper.findAll(".catalogs__unregister")[0]!.trigger("click");
    const confirm = wrapper.findAll(".catalogs__confirm-actions button")[1]!;
    await confirm.trigger("click");
    expect(confirm.attributes("disabled")).toBeDefined();
    await confirm.trigger("click");
    finish();
    await flushPromises();
    expect(calls).toHaveLength(1);
  });
});

describe("UI-45: a catalog's entries", () => {
  it("lists its entries by name, offers Add an entry, and Back returns to the registry", async () => {
    const { wrapper } = await mountCatalogs();
    await press(wrapper, "Manage entries");
    await wrapper.setProps({ at: "personal" });
    expect(wrapper.find(".page-title__heading").text()).toBe("personal");
    expect(wrapper.findAll(".catalogs__entry-name").map((n) => n.text())).toEqual(["alpha", "zeta"]);
    await press(wrapper, "Add an entry");
    expect(useViewStore().addingTo).toBe("personal");
    useViewStore().addingTo = null;
    await wrapper.find(".view__head button").trigger("click");
    expect(useViewStore().current).toEqual({ kind: "catalogs", catalog: null, entry: null });
  });

  it("opened straight at a catalog, Back leaves for the page it came from", async () => {
    const { wrapper } = await mountCatalogs(undefined, {}, "personal");
    useViewStore().manage = { catalog: "personal", entry: null };
    expect(wrapper.find(".view__head button").text()).toBe("← Loadout");
    await wrapper.find(".view__head button").trigger("click");
    expect(useViewStore().manage).toBeNull();
  });

  it("says what to do with an empty catalog", async () => {
    const { wrapper } = await mountCatalogs([personal, catalogRow({ id: "fresh", precedence: 2, entries: 0 })], {}, "fresh");
    expect(wrapper.find(".catalogs__empty").text()).toContain("fresh has no entries yet.");
  });
});
