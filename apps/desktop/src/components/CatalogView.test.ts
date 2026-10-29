import type { Library } from "@loadout/core";
import { catalogRow, entryRecord, installedRecord, seededState, type FakeState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import CatalogView from "./CatalogView.vue";

async function mountList(seed: Partial<FakeState> = seededState(), library: Partial<Library> = {}) {
  const mounted = mountView(CatalogView, { seed, library });
  await useCatalogStore().reload();
  await flushPromises();
  return mounted;
}

type Wrapper = Awaited<ReturnType<typeof mountList>>["wrapper"];
const names = (w: Wrapper) => w.findAll(".entry-list__name").map((n) => n.text());
const button = (w: Wrapper, text: string) => w.findAll("button").find((b) => b.text() === text);
const tab = (w: Wrapper, text: string) => w.findAll(".catalog-tabs__tab").find((b) => b.text().startsWith(text))!;

const two = [catalogRow({ id: "personal" }), catalogRow({ id: "team", precedence: 2, kind: "remote", writeMode: "pr", location: "git@bitbucket.org:acme/catalog.git (main, library.yaml)" })];

describe("UI-10: the list header", () => {
  it("has a labelled search, and Refresh, Catalogs, Accounts and Sync; Enter in the search does nothing", async () => {
    const { wrapper } = await mountList();
    const search = wrapper.find("input[type=search]");
    expect(search.attributes("aria-label")).toBe("Search skills, agents and prompts");
    expect(search.attributes("placeholder")).toBe("Search skills, agents, prompts…");
    expect(wrapper.findAll(".searchbar button").map((b) => b.text())).toEqual(["Refresh", "Catalogs", "Accounts", "Sync"]);

    await wrapper.find("form").trigger("submit");
    expect(useViewStore().current.kind).toBe("list");

    await button(wrapper, "Catalogs")!.trigger("click");
    expect(useViewStore().current).toEqual({ kind: "catalogs", catalog: null, entry: null });
    useViewStore().manage = null;
    await button(wrapper, "Sync")!.trigger("click");
    expect(useViewStore().current.kind).toBe("sync");
  });

  it("opens the clicked copy's page", async () => {
    const { wrapper } = await mountList();
    await wrapper.find("[aria-label='Open lint']").trigger("click");
    expect(useViewStore().current).toMatchObject({ kind: "entry", stop: { name: "lint", catalog: "team" } });
  });
});

describe("UI-13: tabs", () => {
  it("lists All, each catalog with its hue and count (— when skipped), and the disabled count across catalogs", async () => {
    const skipped = catalogRow({ id: "old", precedence: 3, entries: null, skipped: "not cloned yet" });
    const { wrapper } = await mountList({ ...seededState(), catalogs: [...seededState().catalogs, skipped] });
    const tabs = wrapper.findAll(".catalog-tabs__tab").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual(["All", "personal 3", "team 9", "old —", "disabled 1"]);
    expect(tab(wrapper, "old").classes()).toContain("catalog-tabs__tab--skipped");
    expect(tab(wrapper, "team").attributes("style")).toContain("--catalog-hue: 275");

    await tab(wrapper, "personal").trigger("click");
    expect(tab(wrapper, "disabled").text()).toContain("1");
  });

  it("are absent with one catalog and nothing off, and appear for one catalog once something is off", async () => {
    const single = await mountList({ catalogs: [catalogRow()], entries: [installedRecord("installed", { name: "a" })] });
    expect(single.wrapper.find(".catalog-tabs").exists()).toBe(false);

    const off = await mountList({ catalogs: [catalogRow()], entries: [installedRecord("installed", { name: "a", disabled: true })] });
    expect(off.wrapper.findAll(".catalog-tabs__tab").map((t) => t.text().replace(/\s+/g, " "))).toEqual(["All", "personal 0", "disabled 1"]);
  });

  it("shows only what is off on the disabled tab, and falls back to All once nothing is", async () => {
    const { wrapper, library } = await mountList();
    await tab(wrapper, "disabled").trigger("click");
    expect(names(wrapper)).toEqual(["verbose"]);
    expect(wrapper.find(".summary__toggle").exists()).toBe(false);

    library.state.entries = library.state.entries.map((e) => ({ ...e, disabled: false }));
    await useCatalogStore().reload();
    await flushPromises();
    expect(wrapper.find(".catalog-tabs__tab--off").exists()).toBe(false);
    expect(wrapper.find(".catalog-tabs__tab--active").text()).toBe("All");
  });

  it("stays on its tab when a load fails, rather than reading the empty list as nothing being off", async () => {
    const { wrapper, library } = await mountList();
    await tab(wrapper, "disabled").trigger("click");
    const list = library.list;
    library.list = async () => ({ ok: false, error: { code: "CONFIG_INVALID", message: "config.json is not valid" }, warnings: [] });
    await useCatalogStore().reload();
    await flushPromises();

    library.list = list;
    await useCatalogStore().reload();
    await flushPromises();
    expect(names(wrapper)).toEqual(["verbose"]);
  });
});

describe("UI-15: the catalog strip", () => {
  it("says precedence, kind, write mode and location, and offers Manage entries on a catalog Loadout writes, a shared one too", async () => {
    const { wrapper } = await mountList({ catalogs: two, entries: [entryRecord({ name: "a" }), entryRecord({ name: "b", catalog: "team" })] });
    await tab(wrapper, "team").trigger("click");
    expect(wrapper.findAll(".catalog-summary__meta span").map((s) => s.text())).toEqual([
      "precedence 2",
      "remote",
      "writes via pull request",
      "git@bitbucket.org:acme/catalog.git (main, library.yaml)",
    ]);
    await button(wrapper, "Manage entries")!.trigger("click");
    expect(useViewStore().current).toEqual({ kind: "catalogs", catalog: "team", entry: null });
  });

  it("calls a read-only catalog read-only and says why a skipped one contributes nothing", async () => {
    const catalogs = [catalogRow({ writable: false, editable: false }), catalogRow({ id: "old", precedence: 2, entries: null, skipped: "not cloned yet", editable: false })];
    const { wrapper } = await mountList({ catalogs, entries: [entryRecord({ name: "a" })] });
    await tab(wrapper, "personal").trigger("click");
    expect(wrapper.find(".catalog-summary__meta").text()).toContain("read-only");
    await tab(wrapper, "old").trigger("click");
    expect(wrapper.find(".catalog-summary__skipped").text()).toBe("This catalog was skipped, so nothing below comes from it: not cloned yet");
  });
});

describe("UI-16: the counts line", () => {
  it("counts what is shown against what there is; a disabled copy is installed and disabled", async () => {
    const { wrapper } = await mountList();
    expect(wrapper.find(".summary").text()).toContain("12 of 12 entries · 7 installed · 1 disabled · 2 overridden");

    await wrapper.find("input[type=search]").setValue("lint");
    expect(wrapper.find(".summary").text()).toContain("1 of 12 entries · 1 installed");
    expect(wrapper.find(".summary").text()).not.toContain("disabled");
  });

  it("offers Hide overridden on All only while something is overridden, and hides those rows", async () => {
    const { wrapper } = await mountList();
    await wrapper.find(".summary__toggle input").setValue(true);
    expect(wrapper.find(".summary").text()).toContain("10 of 10 entries");

    const none = await mountList({ catalogs: two, entries: [entryRecord({ name: "a" })] });
    expect(none.wrapper.find(".summary__toggle").exists()).toBe(false);
  });
});

describe("UI-17: empty states", () => {
  it("names the search that matched nothing, and offers to clear it", async () => {
    const { wrapper } = await mountList();
    await wrapper.find("input[type=search]").setValue("zzz");
    expect(wrapper.find(".state").text()).toContain("Nothing here matches zzz.");
    await button(wrapper, "Clear the search")!.trigger("click");
    expect(names(wrapper)).toHaveLength(12);
  });

  it("blames an empty catalog rather than the search, offering the first entry only where Loadout writes", async () => {
    const catalogs = [two[0]!, { ...two[1]!, editable: false }, catalogRow({ id: "fresh", precedence: 3, entries: 0 })];
    const { wrapper } = await mountList({ catalogs, entries: [entryRecord({ name: "a" })] });
    await tab(wrapper, "team").trigger("click");
    expect(wrapper.find(".state").text()).toBe("team has no entries yet.");

    await tab(wrapper, "fresh").trigger("click");
    expect(wrapper.find(".state").text()).toContain("fresh has no entries yet.");
    await button(wrapper, "Add the first one")!.trigger("click");
    expect(useViewStore().current).toEqual({ kind: "add", catalog: "fresh" });
  });

  it("says so plainly when no catalog holds anything", async () => {
    const { wrapper } = await mountList({ catalogs: [catalogRow()], entries: [] });
    expect(wrapper.find(".state").text()).toBe("No catalog holds an entry yet. Catalogs above is where you add one.");
  });
});
