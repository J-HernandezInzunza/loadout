import type { Library, Result } from "@loadout/core";
import { entryRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { useCatalogStore } from "./stores/catalog.ts";
import { useViewStore } from "./stores/views.ts";
import { mountView } from "./testing/mountView.ts";

const ok = <T>(value: T, warnings: { message: string }[] = []): Result<T> => ({ ok: true, value, warnings });
const names = (wrapper: ReturnType<typeof mountView>["wrapper"]) => wrapper.findAll(".entry-list__name").map((li) => li.text());
const refreshButton = (wrapper: ReturnType<typeof mountView>["wrapper"]) => wrapper.findAll("button").find((b) => b.text() === "Refresh")!;

/** Mounts the app over a fake that records which ops it was asked for. */
function mountApp(library: Partial<Library> = {}, seed = { entries: [entryRecord({ name: "alpha" }), entryRecord({ name: "beta" })] }) {
  const calls: string[] = [];
  const mounted = mountView(App, {
    seed,
    library: {
      launch: async () => (calls.push("launch"), ok({ state: "ready" as const, catalogs: [] })),
      refresh: async () => (calls.push("refresh"), ok([])),
      ...library,
    },
  });
  return { ...mounted, calls };
}

beforeEach(() => mockIPC(() => null));
afterEach(() => clearMocks());

describe("UI-01: when the app pulls", () => {
  it("launches (which pulls) once on open, then reads the clones on disk", async () => {
    const { wrapper, calls } = mountApp();
    await flushPromises();
    expect(calls).toEqual(["launch"]);
    expect(names(wrapper)).toEqual(["alpha", "beta"]);
  });

  it("reloads after a write without pulling, and pulls again on Refresh", async () => {
    const { wrapper, calls } = mountApp();
    await flushPromises();
    await useCatalogStore().reload();
    expect(calls).toEqual(["launch"]);

    await refreshButton(wrapper).trigger("click");
    await flushPromises();
    expect(calls).toEqual(["launch", "refresh"]);
  });
});

describe("UI-03: loading", () => {
  it("shows Reading the catalog… only for the first load", async () => {
    let finish = () => {};
    const { wrapper } = mountApp({ launch: () => new Promise((resolve) => (finish = () => resolve(ok({ state: "ready" as const, catalogs: [] })))) });
    await flushPromises();
    expect(wrapper.find(".busy").text()).toBe("Reading the catalog…");
    expect(wrapper.find(".entry-list").exists()).toBe(false);

    finish();
    await flushPromises();
    expect(wrapper.find(".busy").exists()).toBe(false);
    expect(names(wrapper)).toEqual(["alpha", "beta"]);
  });

  it("keeps the rows on screen, dimmed and inert, while it re-reads them", async () => {
    let land = () => {};
    const { wrapper, library } = mountApp();
    await flushPromises();
    const list = library.list;
    library.list = (o) => new Promise((resolve) => (land = () => void list(o).then(resolve)));

    void useCatalogStore().reload();
    await flushPromises();
    expect(wrapper.find(".busy").exists()).toBe(false);
    expect(wrapper.find(".entry-list").classes()).toContain("is-refreshing");

    land();
    await flushPromises();
    expect(wrapper.find(".entry-list").classes()).not.toContain("is-refreshing");
  });
});

describe("UI-02, UI-05: a failed load", () => {
  it("shows the error verbatim in place of the list, and empties the list rather than keep a stale one", async () => {
    const { wrapper, library } = mountApp();
    await flushPromises();
    expect(names(wrapper)).toEqual(["alpha", "beta"]);

    library.refresh = async () => ({ ok: false, error: { code: "GIT_FAILED", message: "could not pull 'team':\nfatal: unable to access" }, warnings: [] });
    await refreshButton(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.find(".status-banner--error pre").text()).toBe("could not pull 'team':\nfatal: unable to access");
    expect(wrapper.find(".entry-list").exists()).toBe(false);
    expect(useCatalogStore().entries).toEqual([]);
  });

  it("stringifies a throw rather than swallowing it, and Refresh brings the list back", async () => {
    const { wrapper } = mountApp({
      launch: async () => {
        throw new Error("ipc died");
      },
    });
    await flushPromises();
    expect(wrapper.find(".status-banner--error").text()).toContain("ipc died");

    await refreshButton(wrapper).trigger("click");
    await flushPromises();
    expect(names(wrapper)).toEqual(["alpha", "beta"]);
  });

  it("says why a launch was refused, such as an unreadable config", async () => {
    const { wrapper } = mountApp({ launch: async () => ({ ok: false, error: { code: "CONFIG_INVALID", message: "config.json is not valid" }, warnings: [] }) });
    await flushPromises();
    expect(wrapper.find(".status-banner--error pre").text()).toBe("config.json is not valid");
  });
});

describe("launch warnings", () => {
  it("shows each catalog's pull warning once, beside the list that still loaded, until the next pull", async () => {
    const warning = { message: "catalog 'team': couldn't pull; using the copy on disk" };
    const { wrapper } = mountApp({ launch: async () => ok({ state: "ready" as const, catalogs: [] }, [warning, warning]) });
    await flushPromises();
    expect(wrapper.findAll(".status-banner--warning .warning").map((p) => p.text())).toEqual([warning.message]);
    expect(names(wrapper)).toEqual(["alpha", "beta"]);

    await useCatalogStore().reload();
    await flushPromises();
    expect(wrapper.findAll(".status-banner--warning .warning")).toHaveLength(1);

    await refreshButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".status-banner--warning").exists()).toBe(false);
  });
});

describe("UI-04: freshness", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("says how long ago the catalogs were pulled, ticking every minute, and nothing before the first pull", async () => {
    let finish = () => {};
    const { wrapper } = mountApp({ launch: () => new Promise((resolve) => (finish = () => resolve(ok({ state: "ready" as const, catalogs: [] })))) });
    await flushPromises();
    expect(wrapper.find(".summary__freshness").exists()).toBe(false);

    finish();
    await flushPromises();
    const cue = () => wrapper.find(".summary__freshness").text();
    expect(cue()).toBe("refreshed just now");
    for (const [minutes, text] of [
      [1, "refreshed 1 minute ago"],
      [4, "refreshed 5 minutes ago"],
      [55, "refreshed 1 hour ago"],
      [120, "refreshed 3 hours ago"],
    ] as const) {
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
      expect(cue()).toBe(text);
    }
  });
});

describe("UI-08: the trail after a reload", () => {
  it("drops an open entry page whose name the catalogs no longer hold", async () => {
    const { library } = mountApp();
    await flushPromises();
    const views = useViewStore();
    views.trail.push({ name: "alpha", catalog: "personal" }, { name: "beta", catalog: "personal" });

    library.state.entries = library.state.entries.filter((e) => e.name !== "beta");
    await useCatalogStore().reload();
    expect(views.trail).toEqual([{ name: "alpha", catalog: "personal" }]);
  });
});
