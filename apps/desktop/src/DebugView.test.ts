import { flushPromises, mount } from "@vue/test-utils";
import type { EntryRecord, LaunchReport, Library, PlanItem, Result } from "@loadout/core";
import { createFakeLibrary } from "@loadout/core/testing";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
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
      ["skill", "tidy", "team", "installed (off)", "", "Install"],
      ["skill", "lint", "team", "not_installed", "", "Install"],
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

const ready: Result<LaunchReport> = { ok: true, value: { state: "ready", catalogs: [] }, warnings: [] };
const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const panelLines = (wrapper: ReturnType<typeof mount>) => wrapper.findAll("[data-test=panel] li").map((li) => li.text());

const item = (extra: Partial<PlanItem>): PlanItem =>
  ({
    type: "skill",
    name: "tidy",
    catalog: "team",
    dest: "/home/.claude/skills/tidy",
    status: "ready",
    needsConsent: false,
    preview: { kind: "files", newInstall: false, added: ["b.md"], removed: [], modified: ["SKILL.md"], editedLocally: ["SKILL.md"] },
    ...extra,
  }) as PlanItem;

describe("DebugView actions", () => {
  it("install previews each item, and replacing an unmanaged copy applies with its path consented", async () => {
    const applied: unknown[] = [];
    const plan = { items: [item({ needsConsent: true })] };
    const { wrapper } = setup(ready, {
      planInstall: async () => ok(plan as never),
      applyInstall: async (_plan, opts) => {
        applied.push(opts);
        return ok({ installed: [{ type: "skill" as const, name: "tidy", dest: "/home/.claude/skills/tidy", preview: plan.items[0]!.preview }], stopped: null, aborted: false });
      },
    });
    await flushPromises();
    await wrapper.find("[data-test=install]").trigger("click");
    await flushPromises();
    expect(panelLines(wrapper)).toEqual([
      "skill tidy → /home/.claude/skills/tidy: ready, holds a copy Loadout didn't install, +1 −0 ~1, you edited SKILL.md",
    ]);

    await wrapper.find("[data-test=replace]").trigger("click");
    await flushPromises();
    expect(applied).toEqual([{ overwrite: { unmanaged: ["/home/.claude/skills/tidy"] } }]);
    expect(panelLines(wrapper)).toEqual(["installed skill tidy → /home/.claude/skills/tidy"]);
  });

  it("sync plans, applies and reports; doctor lists its findings", async () => {
    const { wrapper } = setup(ready, {
      planSync: async () => ok({ items: [item({ preview: { kind: "files", newInstall: true, added: [], removed: [], modified: [], editedLocally: [] } })], upToDate: [], unmanaged: [] } as never),
      applySync: async () => ok({ synced: [{ type: "skill" as const, name: "tidy", catalog: "team", dest: "/d", preview: { kind: "destination-only" as const } }], upToDate: [], failed: [], dependencies: [], unmanaged: [], missing: [] }),
      doctor: async () =>
        ok({ status: "problems" as const, entries: 2, errors: [{ check: "8", severity: "error" as const, catalog: "team", entry: null, message: "clone has no origin" }], warnings: [] }),
    });
    await flushPromises();
    await wrapper.find("[data-test=sync]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test=panel] h3").text()).toBe("Sync: 1 to update");
    await wrapper.find("[data-test=apply]").trigger("click");
    await flushPromises();
    expect(panelLines(wrapper)).toEqual(["synced skill tidy", "0 up to date"]);

    await wrapper.find("[data-test=doctor]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test=panel] h3").text()).toBe("Doctor: problems, 2 entries checked");
    expect(panelLines(wrapper)).toEqual(["error [8] team: clone has no origin"]);
  });

  it("a description edit says how the catalog's write mode lands it, and shows the result's link", async () => {
    const discarded: unknown[] = [];
    const plan = { op: "update", write: { mode: "pr" } };
    const { wrapper } = setup(ready, {
      planUpdate: async () => ok(plan as never),
      discardCatalogEdit: async (p) => (discarded.push(p), ok(undefined)),
      applyCatalogEdit: async () =>
        ok({ op: "update" as const, name: "tidy", mode: "pr" as const, catalog: "team", changed: true, method: "manual" as const, branch: "library/update-tidy-1", compareUrl: "https://bitbucket.org/ws/cat/branch/library/update-tidy-1" }),
    });
    await flushPromises();
    // The options' values are entry objects, so select by element rather than setValue's string.
    (wrapper.findAll("[data-test=edit-target] option")[0]!.element as HTMLOptionElement).selected = true;
    await wrapper.find("[data-test=edit-target]").trigger("change");
    await wrapper.find("[data-test=edit-text]").setValue("Tidies things");
    await wrapper.find("[data-test=edit]").trigger("click");
    await flushPromises();
    expect(panelLines(wrapper)).toEqual(["pr mode: pushes a branch and opens a pull request (or gives a compare link)"]);

    await wrapper.find("[data-test=apply]").trigger("click");
    await flushPromises();
    expect(panelLines(wrapper)).toContain("compareUrl: https://bitbucket.org/ws/cat/branch/library/update-tidy-1");
    expect(discarded).toEqual([]);
  });
});

describe("DebugView Bitbucket sign-in", () => {
  afterEach(() => clearMocks());

  function mockApp() {
    const calls: [string, unknown][] = [];
    mockWindows("main");
    mockIPC((cmd, payload) => void calls.push([cmd, payload]), { shouldMockEvents: true });
    return calls;
  }

  it("opens the consent page, then on the loadout:// redirect comes forward and reports the account", async () => {
    const calls = mockApp();
    const started = { on: "bitbucket", authorizeUrl: "https://bitbucket.org/site/oauth2/authorize?client_id=k&state=s" };
    const completed: unknown[] = [];
    const { wrapper } = setup(ready, {
      beginSignIn: async () => ok(started as never),
      completeSignIn: async (s, o) => (completed.push([s, o]), ok({ login: "jose", scopes: [], connectedAt: "2026-10-29T12:00:00Z" })),
    });
    await flushPromises();
    await wrapper.find("[data-test=bitbucket-sign-in]").trigger("click");
    await flushPromises();
    expect(calls).toContainEqual(["plugin:opener|open_url", { url: started.authorizeUrl }]);
    expect(panelLines(wrapper)).toEqual(["Approve Loadout in your browser; Loadout comes back when you do."]);

    const redirectUrl = "loadout://oauth/bitbucket?code=c&state=s";
    await emit("deep-link://new-url", [redirectUrl]);
    await flushPromises();
    expect(calls.some(([cmd]) => cmd === "plugin:window|set_focus")).toBe(true);
    expect(completed).toEqual([[started, { redirectUrl }]]);
    expect(panelLines(wrapper)).toEqual(["Signed in to Bitbucket as jose. You can close the browser tab."]);
  });

  it("a redirect with no sign-in in progress asks to start again", async () => {
    mockApp();
    const { wrapper } = setup(ready);
    await flushPromises();
    await emit("deep-link://new-url", ["loadout://oauth/bitbucket?code=c&state=s"]);
    await flushPromises();
    expect(panelLines(wrapper)).toEqual(["A Bitbucket sign-in came back, but none is in progress here; start it again."]);
  });
});

describe("DebugView GitHub sign-in", () => {
  afterEach(() => clearMocks());

  it("shows the code, opens GitHub's page, and reports the account once signed in", async () => {
    const opened: string[] = [];
    mockIPC((cmd, payload) => {
      if (cmd === "plugin:opener|open_url") opened.push((payload as { url: string }).url);
    });
    let finish: (() => void) | undefined;
    const started = { on: "github", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: "2026-10-29T12:15:00Z" };
    const { wrapper } = setup(ready, {
      beginSignIn: async () => ok(started as never),
      completeSignIn: () =>
        new Promise((resolve) => (finish = () => resolve(ok({ login: "octo", scopes: ["repo"], connectedAt: "2026-10-29T12:01:00Z" })))),
    });
    await flushPromises();
    await wrapper.find("[data-test=github-sign-in]").trigger("click");
    await flushPromises();
    expect(panelLines(wrapper)).toEqual(["Enter WDJB-MJHT at https://github.com/login/device (opening in your browser)."]);
    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(wrapper.find("[data-test=discard]").attributes("disabled")).toBeUndefined();

    finish!();
    await flushPromises();
    expect(panelLines(wrapper)).toEqual(["Signed in to GitHub as octo (repo). You can close the browser tab."]);
  });

  it("Discard cancels a sign-in that is still waiting", async () => {
    mockIPC(() => null);
    let signal: AbortSignal | undefined;
    const { wrapper } = setup(ready, {
      beginSignIn: async () => ok({ on: "github", userCode: "C", verificationUri: "https://github.com/login/device", expiresAt: "x" } as never),
      completeSignIn: (_started, o) =>
        new Promise((resolve) => {
          signal = o?.signal;
          o?.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "CANCELLED", message: "cancelled" }, warnings: [] }));
        }),
    });
    await flushPromises();
    await wrapper.find("[data-test=github-sign-in]").trigger("click");
    await flushPromises();
    await wrapper.find("[data-test=discard]").trigger("click");
    await flushPromises();
    expect(signal?.aborted).toBe(true);
    expect(wrapper.find("[data-test=panel]").exists()).toBe(false);
  });
});
