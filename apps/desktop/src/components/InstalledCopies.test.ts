import type { EntryDetail as Detail, Library } from "@loadout/core";
import { installedRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import EntryDetail from "./EntryDetail.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const DEST = "/Users/dev/.claude/skills/tidy";

function detail(entry = installedRecord("installed", { name: "tidy", catalog: "team" }), dependents: Detail["dependents"] = []): Detail {
  return {
    name: "tidy",
    entry,
    copies: [{ catalog: "team", wins: true, subject: true, pinned: false, overrides: [], overriddenBy: null }],
    requires: [],
    unresolvedRequires: [],
    dependents,
    installs: entry.receipt ? [entry.receipt] : [],
    source: { raw: entry.source, kind: "github", org: "acme", repo: "skills", branch: "main", filePath: "skills/tidy/SKILL.md", parentPath: "skills/tidy", filename: "SKILL.md", cloneUrls: [] },
  };
}

const user = (name: string, installed: boolean) => ({ type: "skill" as const, name, catalog: "team", description: "", direct: true, installed, state: installed ? ("installed" as const) : ("not_installed" as const) });

/** The entry page over a fake whose show() answers `shows` in turn, the last one for good. */
async function mountPage(library: Partial<Library>, shows: Detail[] = [detail()]) {
  let reads = 0;
  const mounted = mountView(EntryDetail, {
    props: { stop: { name: "tidy", catalog: "team" }, back: "Loadout" },
    library: { show: async () => ok(shows[Math.min(reads++, shows.length - 1)]!), ...library },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return mounted;
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};

describe("UI-25: actions on the copy", () => {
  it("offers Send edits back and Remove, one panel open at a time", async () => {
    const { wrapper } = await mountPage({ planPush: () => new Promise(() => {}) });
    expect(wrapper.findAll(".copies__actions button").map((b) => b.text())).toEqual(["Send edits back", "Remove"]);
    await press(wrapper, "Remove");
    expect(wrapper.find(".uninstall").exists()).toBe(true);
    await press(wrapper, "Send edits back");
    expect(wrapper.find(".uninstall").exists()).toBe(false);
    expect(wrapper.find(".push").exists()).toBe(true);
    expect(wrapper.find(".copies__actions button").attributes("aria-expanded")).toBe("true");
  });
});

describe("a copy Loadout didn't install (Q8 A)", () => {
  it("offers the catalog's copy in its place, on the install page that asks first; a copy Loadout installed doesn't", async () => {
    const { wrapper } = await mountPage({}, [detail(installedRecord("unmanaged", { name: "tidy", catalog: "team" }))]);
    expect(wrapper.findAll(".copies__actions button").map((b) => b.text())).toEqual(["Replace with the catalog's copy", "Send edits back", "Remove"]);
    await press(wrapper, "Replace with the catalog's copy");
    expect(useViewStore().current).toEqual({ kind: "install", name: "tidy" });

    const managed = await mountPage({});
    expect(managed.wrapper.findAll(".copies__actions button").map((b) => b.text())).not.toContain("Replace with the catalog's copy");
  });
});

describe("UI-26: removing the copy", () => {
  it("names the copy, its path, what it leaves incomplete and the setting it removes, before deleting anything", async () => {
    const calls: unknown[] = [];
    const off = installedRecord("installed", { name: "tidy", catalog: "team", disabled: true });
    const { wrapper } = await mountPage({ uninstall: async (req) => (calls.push(req), ok({ items: [] })) }, [detail(off, [user("deploy", true), user("ship", true), user("draft", false)])]);
    await press(wrapper, "Remove");
    expect(wrapper.find(".uninstall__question").text()).toBe("Delete the installed copy of tidy?");
    expect(wrapper.find(".uninstall__paths").text()).toBe(DEST);
    expect(wrapper.find(".uninstall__affected").text().replace(/\s+/g, " ")).toBe("2 installed entries depend on this and will be left incomplete: deploy, ship.");
    expect(wrapper.find(".uninstall__override").text()).toBe("Its off setting in Claude Code's settings is removed with it.");
    expect(calls).toEqual([]);
  });

  it("deletes unforced, and the success banner outlives the control as the page reloads", async () => {
    const calls: unknown[] = [];
    const gone = installedRecord("installed", { name: "tidy", catalog: "team" });
    const after = detail({ ...gone, installed: false, state: "not_installed", receipt: null, locations: [] });
    const { wrapper } = await mountPage(
      { uninstall: async (req) => (calls.push(req), ok({ items: [{ type: "skill" as const, name: "tidy", dest: DEST, outcome: "deleted" as const, overrideRemoved: "off" }] })) },
      [detail(), after],
    );
    await press(wrapper, "Remove");
    await press(wrapper, "Delete");

    expect(calls).toEqual([{ names: ["tidy"] }]);
    expect(wrapper.find(".uninstall").exists()).toBe(false);
    expect(wrapper.find(".copies__heading").text()).toBe("On this machine (0)");
    expect(wrapper.find(".status-banner--success").text()).toBe(`Removed ${DEST}. The catalog entry is still listed. Its off setting in Claude Code's settings went with it.`);
  });

  it("turns a refusal into a second confirmation; only that one forces, by this exact path", async () => {
    const calls: { forcePaths?: string[] }[] = [];
    const { wrapper } = await mountPage({
      uninstall: async (req) => {
        calls.push(req);
        const outcome = req.forcePaths ? ("deleted" as const) : ("refused" as const);
        return ok({ items: [{ type: "skill" as const, name: "tidy", dest: DEST, outcome, overrideRemoved: null }] });
      },
    }, [detail(installedRecord("unmanaged", { name: "tidy", catalog: "team" }))]);
    await press(wrapper, "Remove");
    await press(wrapper, "Delete");
    expect(wrapper.find(".uninstall__refused .uninstall__question").text()).toBe("Loadout has no install receipt for this path, so it cannot prove it created it:");
    expect(wrapper.findAll(".uninstall__refused button").map((b) => b.text())).toEqual(["Leave it alone", "Delete anyway"]);

    await press(wrapper, "Delete anyway");
    expect(calls).toEqual([{ names: ["tidy"] }, { names: ["tidy"], forcePaths: [DEST] }]);
    expect(wrapper.find(".status-banner--success").exists()).toBe(true);
  });

  it("leaves everything alone when the refusal is declined", async () => {
    const calls: unknown[] = [];
    const { wrapper } = await mountPage({ uninstall: async (req) => (calls.push(req), ok({ items: [{ type: "skill" as const, name: "tidy", dest: DEST, outcome: "refused" as const, overrideRemoved: null }] })) });
    await press(wrapper, "Remove");
    await press(wrapper, "Delete");
    await press(wrapper, "Leave it alone");
    expect(calls).toHaveLength(1);
    expect(wrapper.find(".uninstall").exists()).toBe(false);
  });

  it("says why a removal failed, at the top of the copies", async () => {
    const { wrapper } = await mountPage({ uninstall: async () => ({ ok: false, error: { code: "REFUSED", message: "permission denied" }, warnings: [] }) });
    await press(wrapper, "Remove");
    await press(wrapper, "Delete");
    expect(wrapper.find(".status-banner--error").text()).toContain("Could not remove tidy.");
    expect(wrapper.find(".status-banner--error pre").text()).toBe("permission denied");
  });
});

describe("UI-27: sending edits back", () => {
  const remotePlan = { kind: "remote", name: "tidy", catalog: "team", dest: DEST, note: "Your copy came from personal, not team.", changed: true, diff: "--- a/SKILL.md\n+++ b/SKILL.md\n-old\n+new" };
  const opened: string[] = [];
  beforeEach(() => {
    opened.length = 0;
    mockIPC((cmd, payload) => {
      if (cmd === "plugin:opener|open_url") opened.push((payload as { url: string }).url);
    });
  });
  afterEach(() => clearMocks());

  it("checks on open, shows the provenance note and the diff, then pushes with the message and offers the PR", async () => {
    const applied: unknown[] = [];
    const discarded: unknown[] = [];
    const { wrapper } = await mountPage({
      planPush: async () => ok(remotePlan as never),
      discardPush: async (p) => (discarded.push(p), ok(undefined)),
      applyPush: async (_plan, o) => (
        applied.push(o?.message),
        ok({ name: "tidy", catalog: "team", dest: DEST, note: null, changed: true, kind: "remote" as const, pr: { method: "api" as const, branch: "library/update-tidy-1", prUrl: "https://github.com/acme/skills/pull/7", compareUrl: null } })
      ),
    });
    await press(wrapper, "Send edits back");
    expect(wrapper.find(".push__provenance").text()).toBe("Your copy came from personal, not team.");
    expect(wrapper.find(".push__diff").text()).toContain("+new");
    expect(wrapper.find(".push__field input").attributes("placeholder")).toBe("library: updated tidy");

    await wrapper.find(".push__field input").setValue("Tighten tidy");
    await press(wrapper, "Push and open a pull request");
    expect(applied).toEqual(["Tighten tidy"]);
    expect(discarded).toEqual([]);
    expect(wrapper.find(".status-banner--success").text()).toContain("Pull request opened.");

    await press(wrapper, "View the pull request");
    expect(opened).toEqual(["https://github.com/acme/skills/pull/7"]);
  });

  it("says when there is nothing to send, and discards the plan when closed", async () => {
    const discarded: unknown[] = [];
    const { wrapper } = await mountPage({ planPush: async () => ok({ ...remotePlan, note: null, changed: false } as never), discardPush: async (p) => (discarded.push(p), ok(undefined)) });
    await press(wrapper, "Send edits back");
    expect(wrapper.find(".push__question").text()).toBe("Nothing to send — this copy already matches its source.");
    expect(wrapper.findAll(".push button").map((b) => b.text())).toEqual(["Cancel"]);
    await press(wrapper, "Cancel");
    expect(discarded).toHaveLength(1);
  });

  it("names the local file a local source would overwrite", async () => {
    const { wrapper } = await mountPage({ planPush: async () => ok({ kind: "local", name: "tidy", catalog: "team", dest: DEST, note: null, changed: true, target: "/Users/dev/src/tidy" } as never), discardPush: async () => ok(undefined) });
    await press(wrapper, "Send edits back");
    expect(wrapper.find(".push__note").text()).toContain("overwrites it directly — no pull request, no review.");
    expect(wrapper.find(".push__dest").text()).toBe("Would overwrite /Users/dev/src/tidy");
    expect(wrapper.find(".push__field").exists()).toBe(false);
    expect(wrapper.findAll(".push button").map((b) => b.text())).toEqual(["Cancel", "Overwrite the source"]);
  });
});
