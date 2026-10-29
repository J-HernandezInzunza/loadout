import type { Library, Result } from "@loadout/core";
import { catalogRow, entryRecord, type FakeState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App.vue";
import { mountView } from "../testing/mountView.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value, warnings: [] });
const refused = (code: string, message: string, problems?: string[]) => ({ ok: false as const, error: { code, message, ...(problems && { problems }) }, warnings: [] }) as never;

const importPlan = {
  toolDir: "/Users/dev/the-library-skill",
  configFile: "/Users/dev/the-library-skill/config.local.yaml",
  configSha256: "abc",
  config: {
    version: 1,
    catalogs: [
      { id: "shared", kind: "remote", repo: "git@bitbucket.org:acme/agentics.git", yamlPath: "library.yaml", branch: "main", protected: true, writable: true },
      { id: "personal", kind: "local", path: "/Users/dev/catalog/library.yaml", writable: true },
    ],
    pins: { grilling: "personal" },
    settings: {},
  },
  notImported: ["autopush: not imported (pull requests open only when you ask)"],
};

const dialogs: unknown[] = [];
const picked = "/Users/dev/elsewhere/the-library-skill";

beforeEach(() => {
  dialogs.length = 0;
  mockIPC((cmd, payload) => {
    if (cmd === "plugin:dialog|open") {
      dialogs.push((payload as { options: unknown }).options);
      return picked;
    }
    return null;
  });
});
afterEach(() => clearMocks());

/** Nothing registered; `register` is what a successful setup adds. */
function emptyState() {
  const state: FakeState = { catalogs: [], entries: [], pins: [], accounts: {} };
  const register = () => {
    state.catalogs.push(catalogRow({ id: "shared", kind: "remote", writeMode: "pr" }));
    state.entries.push(entryRecord({ name: "grilling", catalog: "shared" }));
  };
  return { state, register };
}

/** The app over a fake whose launch answers from that state, as the real one reads config.json. */
function mountFirstRun(library: Partial<Library> = {}, { state } = emptyState()) {
  const calls: unknown[][] = [];
  const mounted = mountView(App, {
    seed: state,
    library: {
      launch: async () => (calls.push(["launch"]), ok({ state: state.catalogs.length === 0 ? ("no-catalogs" as const) : ("ready" as const), catalogs: [] })),
      planImport: async (toolDir) => (calls.push(["planImport", toolDir]), ok(importPlan as never)),
      ...library,
    },
  });
  return { ...mounted, calls };
}

type Wrapper = ReturnType<typeof mountFirstRun>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};
const text = (w: Wrapper, selector: string) => w.findAll(selector).map((e) => e.text().replace(/\s+/g, " "));

describe("first run: nothing registered", () => {
  it("shows set-up instead of an empty list, with the import report read before anything is imported", async () => {
    const { wrapper, calls } = mountFirstRun();
    await flushPromises();
    expect(wrapper.find(".page-title__heading").text()).toBe("Set up Loadout");
    expect(wrapper.find(".entry-list").exists()).toBe(false);
    expect(calls).toEqual([["launch"], ["planImport", undefined]]);
    expect(text(wrapper, ".first-run__catalogs li")).toEqual([
      "shared — git@bitbucket.org:acme/agentics.git (main), changes by pull request",
      "personal — /Users/dev/catalog/library.yaml",
    ]);
    expect(text(wrapper, ".first-run__pins")).toEqual(["and pins grilling to personal."]);
    expect(text(wrapper, ".first-run__left li")).toEqual(["autopush: not imported (pull requests open only when you ask)"]);
  });

  it("imports the plan it showed, then launches again and lands on the loaded list", async () => {
    const fake = emptyState();
    const applied: unknown[] = [];
    const mounted = mountFirstRun({ applyImport: async (plan) => (applied.push(plan), fake.register(), ok({ catalogs: 2, pins: 1, notImported: [] })) }, fake);
    await flushPromises();
    await press(mounted.wrapper, "Import");
    expect(applied).toEqual([importPlan]);
    expect(mounted.calls.filter(([op]) => op === "launch")).toHaveLength(2);
    expect(mounted.wrapper.find(".first-run").exists()).toBe(false);
    expect(mounted.wrapper.findAll(".entry-list__name").map((n) => n.text())).toEqual(["grilling"]);
  });

  it("re-plans when the CLI's file changed after it was read, and says why", async () => {
    const { wrapper, calls } = mountFirstRun({ applyImport: async () => refused("STALE_PLAN", "config.local.yaml changed after the import was planned; plan it again") });
    await flushPromises();
    await press(wrapper, "Import");
    expect(wrapper.find(".first-run").text()).toContain("changed after the import was planned");
    expect(calls.filter(([op]) => op === "planImport")).toEqual([["planImport", undefined], ["planImport", importPlan.toolDir]]);
    expect(wrapper.find(".first-run").exists()).toBe(true);
  });

  it("with no CLI found, says so and offers its folder, then reports what that folder would import", async () => {
    let found = false;
    const { wrapper, calls } = mountFirstRun({
      planImport: async (toolDir) => {
        calls.push(["planImport", toolDir]);
        if (!found) return refused("NOT_FOUND", "no Python CLI at /Users/dev/.claude/skills/library; pick its folder instead");
        return ok(importPlan as never);
      },
    });
    await flushPromises();
    expect(text(wrapper, ".first-run__refusal")).toEqual(["no Python CLI at /Users/dev/.claude/skills/library; pick its folder instead"]);
    expect(wrapper.findAll("button").some((b) => b.text() === "Import")).toBe(false);
    found = true;
    await press(wrapper, "Choose the CLI's folder…");
    expect(dialogs).toEqual([expect.objectContaining({ directory: true })]);
    expect(calls.at(-1)).toEqual(["planImport", picked]);
    expect(text(wrapper, ".first-run__catalogs li")).toHaveLength(2);
  });

  it("lists the problems that stop an invalid CLI config from importing, and offers no Import", async () => {
    const { wrapper } = mountFirstRun({
      planImport: async () => refused("CONFIG_INVALID", "config.local.yaml can't be imported until these are fixed", ["catalogs[0]: missing 'id'"]),
    });
    await flushPromises();
    expect(text(wrapper, ".first-run__problems li")).toEqual(["catalogs[0]: missing 'id'"]);
    expect(wrapper.findAll("button").some((b) => b.text() === "Import")).toBe(false);
  });

  it("adds a team catalog from a pasted repository URL and lands on the loaded list", async () => {
    const fake = emptyState();
    const requests: unknown[] = [];
    const { wrapper } = mountFirstRun({
      planImport: async () => refused("NOT_FOUND", "no Python CLI"),
      planAddCatalog: async (req) => (requests.push({ ...req, signal: undefined }), ok({ ref: { id: req.id }, position: "first", file: "/x/library.yaml", entries: 1 } as never)),
      applyAddCatalog: async () => (fake.register(), ok([{ id: "shared", kind: "local" as const, path: "/x" }])),
    }, fake);
    await flushPromises();
    await press(wrapper, "Paste a repository URL…");
    expect(wrapper.find("input[value=remote]").element).toHaveProperty("checked", true);
    // The first catalog has nothing to collide with, so precedence isn't asked.
    expect(wrapper.text()).not.toContain("use this catalog's copy");
    const [id, repo, branch] = wrapper.findAll("input[type=text]");
    await id!.setValue("shared");
    await repo!.setValue("git@bitbucket.org:acme/agentics.git");
    await branch!.setValue("main");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(requests).toEqual([{ kind: "remote", id: "shared", repo: "git@bitbucket.org:acme/agentics.git", branch: "main", protected: true, position: "first", signal: undefined }]);
    expect(wrapper.find(".first-run").exists()).toBe(false);
    expect(wrapper.findAll(".entry-list__name").map((n) => n.text())).toEqual(["grilling"]);
  });

  it("creates a personal catalog, prefilled 'personal', and lands on the loaded list", async () => {
    const fake = emptyState();
    const created: unknown[] = [];
    const { wrapper } = mountFirstRun({
      initCatalog: async (req) => (created.push(req), fake.register(), ok({ created: `${req.path}/library.yaml`, catalogs: [{ id: "personal", kind: "local" as const, path: req.path }] })),
    }, fake);
    await flushPromises();
    await press(wrapper, "Create a personal catalog…");
    expect((wrapper.find("input[type=text]").element as HTMLInputElement).value).toBe("personal");
    await press(wrapper, "Choose folder…");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(created).toEqual([{ path: picked, id: "personal", position: "first" }]);
    expect(wrapper.find(".first-run").exists()).toBe(false);
    expect(wrapper.findAll(".entry-list__name").map((n) => n.text())).toEqual(["grilling"]);
  });

  it("goes back from adding to set-up", async () => {
    const { wrapper } = mountFirstRun();
    await flushPromises();
    await press(wrapper, "Paste a repository URL…");
    await press(wrapper, "← Set up Loadout");
    expect(text(wrapper, ".first-run__title")).toEqual(["Import from the Python CLI", "Add a catalog"]);
  });

  it("never shows when a catalog is registered, nor when the launch failed", async () => {
    const registered = mountView(App);
    await flushPromises();
    expect(registered.wrapper.find(".first-run").exists()).toBe(false);

    const failed = mountView(App, { seed: { catalogs: [] }, library: { launch: async () => refused("CONFIG_INVALID", "config.json is not a config this version of Loadout can read") } });
    await flushPromises();
    expect(failed.wrapper.find(".first-run").exists()).toBe(false);
    expect(failed.wrapper.text()).toContain("config.json is not a config");
  });
});
