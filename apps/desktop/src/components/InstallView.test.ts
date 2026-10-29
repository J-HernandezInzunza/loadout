import type { Library, PlanItem } from "@loadout/core";
import { entryRecord, installedRecord, seededState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../App.vue";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import InstallView from "./InstallView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const files = (extra: Partial<Extract<PlanItem["preview"], { kind: "files" }>> = {}) => ({ kind: "files" as const, newInstall: false, added: [], removed: [], modified: [], editedLocally: [], ...extra });

function item(name: string, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    type: "skill",
    name,
    catalog: "team",
    catalogKey: "team",
    source: `https://github.com/acme/skills/blob/main/skills/${name}/SKILL.md`,
    dest: `/Users/dev/.claude/skills/${name}`,
    requiredBy: [],
    provenance: { overrides: [], overriddenBy: null, pinned: false },
    state: "absent",
    needsConsent: false,
    status: "ready",
    preview: files({ newInstall: true }),
    destFingerprint: "x",
    ...extra,
  } as PlanItem;
}

const two = [entryRecord({ name: "tidy", overriddenBy: "team" }), installedRecord("installed", { name: "tidy", catalog: "team", pinned: true, overrides: ["personal"] })];

/** The install page for tidy over a fake recording each op; planInstall answers `plans` in turn. */
async function mountInstall(plans: PlanItem[][], extra: Partial<Library> = {}, entries = [entryRecord({ name: "tidy", catalog: "team" })]) {
  const calls: unknown[][] = [];
  let planned = 0;
  const mounted = mountView(InstallView, {
    seed: { ...seededState(), entries },
    props: { name: "tidy", back: "tidy" },
    library: {
      planInstall: async (req) => (calls.push(["planInstall", req.names, req.catalog]), ok({ items: plans[Math.min(planned++, plans.length - 1)]!, opDir: "/tmp/op", fingerprint: "f" } as never)),
      applyInstall: async (plan) => (calls.push(["applyInstall"]), ok({ installed: plan.items.filter((i) => i.status === "ready").map((i) => ({ type: i.type, name: i.name, dest: i.dest, preview: i.preview })), stopped: null, aborted: false })),
      discardPlan: async () => (calls.push(["discardPlan"]), ok(undefined)),
      planPin: async (req) => (calls.push(["planPin", req.catalog]), ok({ name: "tidy", catalog: req.catalog } as never)),
      applyPin: async (p, o) => (calls.push(["applyPin", p.catalog, o.switchInstalled]), ok({} as never)),
      ...extra,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountInstall>>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};
const go = (w: Wrapper) => w.find(".install-preview__go");

describe("UI-28: the install hand-off", () => {
  it("opens the install page from the entry page, with Back naming the entry", async () => {
    const { wrapper } = mountView(App, { library: { launch: async () => ok({ state: "ready" as const, catalogs: [] }) } });
    await flushPromises();
    useViewStore().trail.push({ name: "tidy", catalog: "team" });
    await flushPromises();
    await wrapper.findAll("button").find((b) => b.text() === "Install and set up")!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".page-title__heading").text()).toBe("Install and set up");
    expect(wrapper.find(".entry-install__name").text()).toBe("tidy");
    expect(wrapper.find(".view__head button").text()).toBe("← tidy");
  });
});

describe("UI-32: the source picker", () => {
  it("is absent when one catalog holds the name", async () => {
    const { wrapper } = await mountInstall([[item("tidy")]]);
    expect(wrapper.find(".install-preview__source").exists()).toBe(false);
  });

  it("lists each holder, the default marked, and plans the chosen copy", async () => {
    const { wrapper, calls } = await mountInstall([[item("tidy")]], {}, two);
    expect(wrapper.findAll(".install-preview__source option").map((o) => o.text())).toEqual(["personal", "team · default, pinned"]);
    await wrapper.find(".install-preview__source").setValue("personal");
    expect(wrapper.find(".install-preview__remember").text()).toContain("Always use personal for tidy.");
    await press(wrapper, "Preview install");
    expect(calls).toEqual([["planInstall", ["tidy"], "personal"]]);
  });

  it("pins before installing when asked to remember, and a refused pin writes nothing", async () => {
    const refused = await mountInstall([[item("tidy")]], { planPin: async () => ({ ok: false, error: { code: "REFUSED", message: "no" }, warnings: [] }) }, two);
    await refused.wrapper.find(".install-preview__source").setValue("personal");
    await refused.wrapper.find(".install-preview__remember input").setValue(true);
    await press(refused.wrapper, "Preview install");
    await refused.wrapper.find(".install-preview__go").trigger("click");
    await flushPromises();
    expect(refused.calls.map((c) => c[0])).toEqual(["planInstall"]);
    expect(refused.wrapper.find(".status-banner--error pre").text()).toBe("no");

    const pinned = await mountInstall([[item("tidy")]], {}, two);
    await pinned.wrapper.find(".install-preview__source").setValue("personal");
    await pinned.wrapper.find(".install-preview__remember input").setValue(true);
    await press(pinned.wrapper, "Preview install");
    await pinned.wrapper.find(".install-preview__go").trigger("click");
    await flushPromises();
    expect(pinned.calls.map((c) => c[0])).toEqual(["planInstall", "planPin", "applyPin", "applyInstall"]);
    expect(pinned.calls[2]).toEqual(["applyPin", "personal", false]);
  });
});

describe("UI-34: the preview", () => {
  it("lists each destination with its state, dependencies tagged, and which files change, flagging the ones you edited", async () => {
    const { wrapper } = await mountInstall([
      [
        item("lint", { requiredBy: ["tidy"] }),
        item("tidy", { state: "drifted", preview: files({ modified: ["SKILL.md", "notes.md"], added: ["new.md"], removed: ["old.md"], editedLocally: ["SKILL.md"] }) }),
      ],
    ]);
    await press(wrapper, "Preview install");
    const heads = wrapper.findAll(".install-preview__item-head").map((h) => h.findAll(":scope > *").map((c) => c.text()));
    expect(heads).toEqual([
      ["lint", "dependency", "new"],
      ["tidy", "edited locally"],
    ]);
    expect(wrapper.findAll(".install-preview__files li").map((l) => l.text().replace(/\s+/g, " "))).toEqual(["~ SKILL.md · you edited this", "~ notes.md", "+ new.md", "- old.md"]);
    expect(wrapper.find(".install-preview__scope").text()).toBe("nothing has been written");
  });

  it("falls back to the destinations when the source can't be fetched", async () => {
    const { wrapper } = await mountInstall([[item("tidy", { state: "installed", preview: { kind: "destination-only" } })]]);
    await press(wrapper, "Preview install");
    expect(wrapper.text()).toContain("Couldn't fetch the source, so only the destinations are shown");
    expect(wrapper.find(".install-preview__files").exists()).toBe(false);
  });

  it("reports a destination holding a copy Loadout didn't install, and doesn't offer to install over it", async () => {
    const { wrapper } = await mountInstall([[item("tidy", { state: "unmanaged", needsConsent: true })]]);
    await press(wrapper, "Preview install");
    expect(wrapper.find(".install-preview__item").text()).toContain("This holds a copy Loadout didn't install, so Loadout leaves it alone.");
    expect(go(wrapper).attributes("disabled")).toBeDefined();
  });
});

describe("UI-35: the drift gate", () => {
  it("keeps Install disabled until overwriting the edited copies is acknowledged, dependencies included", async () => {
    const { wrapper } = await mountInstall([[item("lint", { requiredBy: ["tidy"], state: "drifted" }), item("tidy", { state: "installed" })]]);
    await press(wrapper, "Preview install");
    expect(wrapper.find(".install-preview__ack").text()).toBe("Overwrite 1 locally edited copy, discarding those edits.");
    expect(go(wrapper).attributes("disabled")).toBeDefined();
    await wrapper.find(".install-preview__ack input").setValue(true);
    expect(go(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("doesn't gate a copy Loadout installed and nobody edited", async () => {
    const { wrapper } = await mountInstall([[item("tidy", { state: "installed" })]]);
    await press(wrapper, "Preview install");
    expect(wrapper.find(".install-preview__ack").exists()).toBe(false);
    expect(go(wrapper).attributes("disabled")).toBeUndefined();
  });
});

describe("UI-36: installing", () => {
  it("says Install, or Reinstall when every destination is already there, with the caution for clean copies", async () => {
    const fresh = await mountInstall([[item("tidy")]]);
    await press(fresh.wrapper, "Preview install");
    expect(go(fresh.wrapper).text()).toBe("Install");

    const again = await mountInstall([[item("tidy", { state: "installed" })]]);
    await press(again.wrapper, "Preview install");
    expect(go(again.wrapper).text()).toBe("Reinstall");
    expect(again.wrapper.find(".install-preview__caution").text()).toBe("Every copy already matches its source, so this only changes anything if the source has moved on since.");
  });

  it("reports what it installed, item by item, with the files that changed", async () => {
    const { wrapper } = await mountInstall([[item("lint", { requiredBy: ["tidy"] }), item("tidy", { state: "installed", preview: files({ modified: ["SKILL.md"], added: ["a.md", "b.md"] }) })]]);
    await press(wrapper, "Preview install");
    await go(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".install-preview__done").text()).toBe("Installed 2 items.");
    expect(wrapper.findAll(".install-preview__state").map((s) => s.text())).toEqual(["new install", "1 modified, 2 added"]);
    expect(wrapper.findAll(".install-preview__files li").map((l) => l.text())).toEqual(["~ SKILL.md", "+ a.md", "+ b.md"]);
  });

  it("re-plans when the destination changed since the preview", async () => {
    let applies = 0;
    const { wrapper, calls } = await mountInstall([[item("tidy")]], {
      applyInstall: async () => (applies++ === 0 ? { ok: false, error: { code: "STALE_PLAN", message: "changed" }, warnings: [] } : ok({ installed: [], stopped: null, aborted: false })),
    });
    await press(wrapper, "Preview install");
    await go(wrapper).trigger("click");
    await flushPromises();
    expect(calls.filter((c) => c[0] === "planInstall")).toHaveLength(2);
    expect(wrapper.find(".status-banner--warning").text()).toBe("Something changed since the preview, so here is a fresh one.");
    expect(go(wrapper).exists()).toBe(true);
  });

  it("says where it stopped, keeping what installed before it", async () => {
    const { wrapper } = await mountInstall([[item("tidy")]], { applyInstall: async () => ok({ installed: [], stopped: { name: "tidy", reason: "disk full" }, aborted: false }) });
    await press(wrapper, "Preview install");
    await go(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".status-banner--error").text()).toContain("Stopped at tidy; what installed before it stays installed.");
  });

  it("discards an unapplied plan when the page closes", async () => {
    const { wrapper, calls } = await mountInstall([[item("tidy")]]);
    await press(wrapper, "Preview install");
    wrapper.unmount();
    await flushPromises();
    expect(calls.at(-1)).toEqual(["discardPlan"]);
  });
});
