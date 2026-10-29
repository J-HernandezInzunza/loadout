import { flushPromises, mount } from "@vue/test-utils";
import type { EntryRecord, LaunchReport, Library, Result } from "@loadout/core";
import { createFakeLibrary } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import DebugView from "./DebugView.vue";
import { createAuditLog } from "./host-tauri/audit.ts";

const record = (name: string, extra: Partial<EntryRecord> = {}): EntryRecord => ({
  type: "skill",
  name,
  description: name,
  source: `~/src/${name}/SKILL.md`,
  requires: [],
  catalog: "team",
  overrides: [],
  overriddenBy: null,
  pinned: false,
  installed: false,
  state: "not_installed",
  receipt: null,
  locations: [],
  disabled: false,
  ...extra,
});

const catalog = { precedence: 1, id: "team", kind: "remote" as const, location: "git@x:o/cat.git (main, library.yaml)", writeMode: "pr" as const, writable: true, entries: 2, skipped: null };

function setup(launched: Result<LaunchReport>, overrides: Partial<Library> = {}) {
  const library = createFakeLibrary({ catalogs: [catalog], entries: [record("tidy", { state: "installed", installed: true, disabled: true }), record("lint")] }, overrides);
  const log = createAuditLog();
  log.record({ kind: "proc:start", id: 1, argv: ["git", "pull", "--ff-only"], cwd: "/app/clones/team" });
  const wrapper = mount(DebugView, { props: { library, log, launched: Promise.resolve(launched) } });
  return { wrapper, log };
}

describe("DebugView", () => {
  it("shows the launch state, catalogs, entries with install state, and the audit log as it grows", async () => {
    const { wrapper, log } = setup({ ok: true, value: { state: "ready", catalogs: [{ id: "team", outcome: "pulled" }] }, warnings: [{ message: "catalog 'old' skipped" }] });
    await flushPromises();
    log.record({ kind: "proc:end", id: 1, code: 0, durationMs: 412 });
    await flushPromises();

    expect(wrapper.find(".debug-view__status").text()).toBe("ready");
    expect(wrapper.find(".debug-view__import").exists()).toBe(false);
    expect(wrapper.find(".debug-view__warnings").text()).toBe("catalog 'old' skipped");
    expect(wrapper.find("[data-test=catalogs]").text()).toContain("team");
    expect(wrapper.find("[data-test=catalogs]").text()).toContain("2 entries");
    expect(wrapper.findAll("[data-test=entries] tr").map((r) => r.findAll("td").map((d) => d.text()))).toEqual([
      ["skill", "tidy", "team", "installed (off)", ""],
      ["skill", "lint", "team", "not_installed", ""],
    ]);
    expect(wrapper.findAll("[data-test=audit] li").map((li) => li.text())).toEqual([
      "#1 $ git pull --ff-only  (in /app/clones/team)",
      "#1 exit 0 in 412 ms",
    ]);
  });

  it("shows why the launch failed", async () => {
    const { wrapper } = setup({ ok: false, error: { code: "CONFIG_INVALID", message: "config.json is not valid" }, warnings: [] });
    await flushPromises();
    expect(wrapper.find(".debug-view__status").text()).toBe("launch failed: CONFIG_INVALID: config.json is not valid");
  });

  it("with no catalogs registered, imports the Python CLI's registry and launches again", async () => {
    const calls: string[] = [];
    const { wrapper } = setup(
      { ok: true, value: { state: "no-catalogs", catalogs: [] }, warnings: [] },
      {
        planImport: async () => (calls.push("plan"), { ok: true, value: {} as never, warnings: [] }),
        applyImport: async () => (calls.push("apply"), { ok: true, value: { catalogs: 1, pins: 0, notImported: ["autopush: pull requests open only when you ask"] }, warnings: [] }),
        launch: async () => (calls.push("launch"), { ok: true, value: { state: "ready", catalogs: [{ id: "team", outcome: "cloned" }] }, warnings: [] }),
      },
    );
    await flushPromises();
    expect(wrapper.find(".debug-view__status").text()).toBe("no catalogs registered");

    await wrapper.find(".debug-view__import").trigger("click");
    await flushPromises();
    expect(calls).toEqual(["plan", "apply", "launch"]);
    expect(wrapper.find(".debug-view__status").text()).toBe("ready");
    expect(wrapper.find(".debug-view__warnings").text()).toBe("not imported: autopush: pull requests open only when you ask");
  });
});
