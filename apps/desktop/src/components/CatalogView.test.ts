import type { Library } from "@loadout/core";
import { accountInfo, catalogRow, entryRecord, installedRecord, seededState, type FakeState } from "@loadout/core/testing";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import App from "../App.vue";
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
const from = async (w: Wrapper, id: string) => {
  await w.find(".toolbar__from select").setValue(id);
  await flushPromises();
};
const show = async (w: Wrapper, state: string) => {
  await w.findAll(".toolbar__state button").find((b) => b.text().startsWith(state))!.trigger("click");
  await flushPromises();
};
const browse = async (w: Wrapper, label: string) => {
  await w.findAll(".sidebar__item").find((b) => b.text().startsWith(label))!.trigger("click");
  await flushPromises();
};
const fromOptions = (w: Wrapper) => w.findAll(".toolbar__from option").map((o) => o.text());
const itemText = (b: ReturnType<Wrapper["find"]>) => b.findAll("span").map((t) => t.text()).join(" ");
const states = (w: Wrapper) => w.findAll(".toolbar__state button").map((b) => b.text().replace(/\s+/g, " "));

const two = [catalogRow({ id: "personal" }), catalogRow({ id: "team", precedence: 2, kind: "remote", writeMode: "pr", location: "git@bitbucket.org:acme/catalog.git (main, library.yaml)" })];

describe("UI-10: the list header and the sidebar", () => {
  afterEach(() => clearMocks());

  it("has the Browse choice as its title, a labelled search and Refresh; Enter in the search does nothing", async () => {
    const { wrapper } = await mountList();
    expect(wrapper.find("h1").text()).toBe("All");
    const search = wrapper.find("input[type=search]");
    expect(search.attributes("aria-label")).toBe("Search skills, agents and prompts");
    expect(search.attributes("placeholder")).toBe("Search skills, agents, prompts…");
    expect(wrapper.findAll(".searchbar button").map((b) => b.text())).toEqual(["Refresh"]);
    await wrapper.find("form").trigger("submit");
    expect(useViewStore().current.kind).toBe("list");
  });

  it("browses by type with a count of names for each, and the title follows", async () => {
    const { wrapper } = await mountList();
    const items = wrapper.findAll("nav .sidebar__item").map(itemText);
    expect(items).toEqual(["All 10", "Skills 8", "Prompts 1", "Agents 1"]);
    expect(wrapper.find("nav [aria-pressed=true]").text()).toContain("All");

    await browse(wrapper, "Prompts");
    expect(wrapper.find("h1").text()).toBe("Prompts");
    expect(names(wrapper)).toEqual(["standup"]);
    expect(wrapper.find(".summary").text()).toContain("1 of 1 prompts");
  });

  it("opens Sync and Catalogs from the sidebar, and the list is as it was on coming back", async () => {
    const { wrapper } = mountView(App, { library: { launch: async () => ({ ok: true, value: { state: "ready" as const, catalogs: [] }, warnings: [] }) } });
    await flushPromises();
    await browse(wrapper, "Skills");
    await from(wrapper, "team");
    await wrapper.find("input[type=search]").setValue("lint");
    await browse(wrapper, "Catalogs");
    expect(useViewStore().current).toEqual({ kind: "catalogs", catalog: null, entry: null });
    useViewStore().manage = null;
    await flushPromises();
    await browse(wrapper, "Sync");
    expect(useViewStore().current.kind).toBe("sync");
    useViewStore().sync = false;
    await flushPromises();

    expect(wrapper.find("h1").text()).toBe("Skills");
    expect((wrapper.find(".toolbar__from select").element as HTMLSelectElement).value).toBe("team");
    expect((wrapper.find("input[type=search]").element as HTMLInputElement).value).toBe("lint");
    expect(names(wrapper)).toEqual(["lint"]);
  });

  it("shows each account's login, or Connect, and opens Accounts from either", async () => {
    const { wrapper } = await mountList({ ...seededState(), accounts: { github: accountInfo({ login: "octo" }) } });
    const rows = wrapper.findAll(".sidebar__accounts .sidebar__item").map(itemText);
    expect(rows).toEqual(["GitHub octo", "Bitbucket Connect"]);
    // The host name never gives way; the login is the part that truncates.
    expect(wrapper.find(".sidebar__accounts .sidebar__host").text()).toBe("GitHub");
    expect(wrapper.find(".sidebar__accounts .sidebar__login").attributes("title")).toBe("octo");
    await browse(wrapper, "Bitbucket");
    expect(useViewStore().current.kind).toBe("accounts");
  });

  it("shows the running build's version at its foot", async () => {
    mockIPC((cmd) => (cmd === "plugin:app|version" ? "0.1.0-rc.1" : undefined));
    const { wrapper } = await mountList();
    expect(wrapper.find(".sidebar__version").text()).toBe("Version 0.1.0-rc.1");
  });

  it("opens the clicked copy's page", async () => {
    const { wrapper } = await mountList();
    await wrapper.find("[aria-label='Open lint']").trigger("click");
    expect(useViewStore().current).toMatchObject({ kind: "entry", stop: { name: "lint", catalog: "team" } });
  });
});

describe("UI-13: From and the state", () => {
  it("offers every catalog, then each with its count (not loaded when skipped), and Disabled only while something is off", async () => {
    const skipped = catalogRow({ id: "old", precedence: 3, entries: null, skipped: "not cloned yet" });
    const { wrapper } = await mountList({ ...seededState(), catalogs: [...seededState().catalogs, skipped] });
    expect(fromOptions(wrapper)).toEqual(["every catalog", "personal (3)", "team (9)", "old (not loaded)"]);
    expect(states(wrapper)).toEqual(["Any", "Installed", "Disabled 1"]);

    const none = await mountList({ catalogs: [catalogRow()], entries: [installedRecord("installed", { name: "a" })] });
    expect(states(none.wrapper)).toEqual(["Any", "Installed"]);
    expect(fromOptions(none.wrapper)).toEqual(["every catalog", "personal (0)"]);
  });

  it("shows only what is off as Disabled, and falls back to Any once nothing is", async () => {
    const { wrapper, library } = await mountList();
    await show(wrapper, "Disabled");
    expect(names(wrapper)).toEqual(["verbose"]);
    expect(wrapper.find(".toolbar__toggle").exists()).toBe(false);

    library.state.entries = library.state.entries.map((e) => ({ ...e, disabled: false }));
    await useCatalogStore().reload();
    await flushPromises();
    expect(states(wrapper)).toEqual(["Any", "Installed"]);
    expect(wrapper.find(".toolbar__state [aria-pressed=true]").text()).toBe("Any");
  });

  it("falls back to every catalog once the chosen one is unregistered", async () => {
    const { wrapper, library } = await mountList();
    await from(wrapper, "team");
    library.state.catalogs = library.state.catalogs.filter((c) => c.id !== "team");
    await useCatalogStore().reload();
    await flushPromises();
    expect((wrapper.find(".toolbar__from select").element as HTMLSelectElement).value).toBe("");
  });

  it("stays on its choice when a load fails, rather than reading the empty list as nothing being off", async () => {
    const { wrapper, library } = await mountList();
    await show(wrapper, "Disabled");
    const list = library.list;
    library.list = async () => ({ ok: false, error: { code: "CONFIG_INVALID", message: "config.json is not valid" }, warnings: [] });
    await useCatalogStore().reload();
    await flushPromises();

    library.list = list;
    await useCatalogStore().reload();
    await flushPromises();
    expect(names(wrapper)).toEqual(["verbose"]);
  });

  it("combines the type, the catalog, the state and the search", async () => {
    const { wrapper } = await mountList();
    await browse(wrapper, "Skills");
    await from(wrapper, "team");
    await show(wrapper, "Installed");
    const installedTeamSkills = names(wrapper);
    expect(installedTeamSkills.length).toBeGreaterThan(0);
    expect(wrapper.find(".summary").text()).toMatch(/^\d+ of \d+ skills/);
    await wrapper.find("input[type=search]").setValue(installedTeamSkills[0]!);
    expect(names(wrapper)).toContain(installedTeamSkills[0]);
    expect(names(wrapper).length).toBeLessThanOrEqual(installedTeamSkills.length);
  });
});

describe("UI-15: the catalog strip", () => {
  it("says precedence, kind, write mode and location, and offers Manage entries on a catalog Loadout writes, a shared one too", async () => {
    const { wrapper } = await mountList({ catalogs: two, entries: [entryRecord({ name: "a" }), entryRecord({ name: "b", catalog: "team" })] });
    await from(wrapper, "team");
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
    await from(wrapper, "personal");
    expect(wrapper.find(".catalog-summary__meta").text()).toContain("read-only");
    await from(wrapper, "old");
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

  it("offers Hide overridden for every catalog only while something is overridden, and hides those rows", async () => {
    const { wrapper } = await mountList();
    await wrapper.find(".toolbar__toggle input").setValue(true);
    expect(wrapper.find(".summary").text()).toContain("10 of 10 entries");
    await from(wrapper, "team");
    expect(wrapper.find(".toolbar__toggle").exists()).toBe(false);

    const none = await mountList({ catalogs: two, entries: [entryRecord({ name: "a" })] });
    expect(none.wrapper.find(".toolbar__toggle").exists()).toBe(false);
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

  it("blames an empty catalog rather than the search, naming the type, and offers the first entry only where Loadout writes", async () => {
    const catalogs = [two[0]!, { ...two[1]!, editable: false }, catalogRow({ id: "fresh", precedence: 3, entries: 0 })];
    const { wrapper } = await mountList({ catalogs, entries: [entryRecord({ name: "a" })] });
    await from(wrapper, "team");
    expect(wrapper.find(".state").text()).toBe("team has no entries yet.");

    await from(wrapper, "fresh");
    await browse(wrapper, "Prompts");
    expect(wrapper.find(".state").text()).toContain("fresh has no prompts yet.");
    await button(wrapper, "Add the first one")!.trigger("click");
    expect(useViewStore().current).toEqual({ kind: "add", catalog: "fresh" });
  });

  it("says when a type or Installed leaves nothing, every catalog included", async () => {
    const { wrapper } = await mountList({ catalogs: two, entries: [entryRecord({ name: "a" })] });
    await browse(wrapper, "Agents");
    expect(wrapper.find(".state").text()).toBe("No catalog holds any agents yet.");
    await browse(wrapper, "All");
    await show(wrapper, "Installed");
    expect(wrapper.find(".state").text()).toBe("No entries installed yet.");
  });

  it("says so plainly when no catalog holds anything", async () => {
    const { wrapper } = await mountList({ catalogs: [catalogRow()], entries: [] });
    expect(wrapper.find(".state").text()).toBe("No catalog holds an entry yet. Catalogs in the sidebar is where you add one.");
  });
});
