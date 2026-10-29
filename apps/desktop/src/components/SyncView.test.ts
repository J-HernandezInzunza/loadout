import type { Library, PlanItem } from "@loadout/core";
import { receipt } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import SyncView from "./SyncView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const ref = (name: string) => ({ type: "skill" as const, name, catalog: "team" });
const files = (extra = {}) => ({ kind: "files" as const, newInstall: false, added: [], removed: [], modified: [], editedLocally: [], ...extra });

function item(name: string, extra: Partial<PlanItem> = {}): PlanItem {
  return { ...ref(name), dest: `/Users/dev/.claude/skills/${name}`, requiredBy: [], state: "installed", needsConsent: false, status: "ready", preview: files({ modified: ["SKILL.md"] }), ...extra } as PlanItem;
}

type Plan = { items: PlanItem[]; upToDate: (ReturnType<typeof ref> & { status: "up-to-date" | "unmoved" })[]; unmanaged: (ReturnType<typeof ref> & { dest: string; origin: "foreign" })[] };

async function mountSync(plans: Plan[], library: Partial<Library> = {}) {
  const calls: unknown[][] = [];
  let planned = 0;
  const mounted = mountView(SyncView, {
    library: {
      planSync: async (req) => (calls.push(["planSync", req?.force ?? false]), ok({ ...plans[Math.min(planned++, plans.length - 1)]!, opDir: "/tmp/op", fingerprint: "f" } as never)),
      discardPlan: async () => (calls.push(["discardPlan"]), ok(undefined)),
      applySync: async (plan) => (
        calls.push(["applySync"]),
        ok({ synced: plan.items.map((i) => ({ ...ref(i.name), dest: i.dest, preview: i.preview })), upToDate: plan.upToDate, failed: [], dependencies: [], unmanaged: plan.unmanaged, missing: [] })
      ),
      ...library,
    },
  });
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountSync>>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};
const summary = (w: Wrapper) => w.find(".sync__summary").text().replace(/\s+/g, " ");

describe("UI-38: sync", () => {
  it("checks on open and writes nothing until confirmed, listing what it would update and what it leaves alone", async () => {
    const { wrapper, calls } = await mountSync([
      { items: [item("tidy"), item("lint", { requiredBy: ["tidy"], state: "absent" })], upToDate: [{ ...ref("notes"), status: "up-to-date" }], unmanaged: [{ ...ref("grill"), dest: "/Users/dev/.claude/skills/grill", origin: "foreign" }] },
    ]);
    expect(calls).toEqual([["planSync", false]]);
    expect(summary(wrapper)).toBe("2 to update · 1 already up to date · nothing has been written");
    expect(wrapper.findAll(".sync__item--changed .sync__name").map((n) => n.text())).toEqual(["tidy", "lint"]);
    expect(wrapper.text()).toContain("Loadout didn't install the copies at these destinations, so sync never overwrites them.");

    await press(wrapper, "Sync 2");
    expect(calls).toEqual([["planSync", false], ["applySync"]]);
    expect(summary(wrapper)).toBe("2 updated · 1 already up to date");
  });

  it("says everything is up to date when there is nothing to do, and Force re-fetch plans again forced", async () => {
    const { wrapper, calls } = await mountSync([{ items: [], upToDate: [{ ...ref("tidy"), status: "unmoved" }], unmanaged: [] }]);
    expect(summary(wrapper)).toContain("Everything is up to date");
    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("Sync 0");
    await press(wrapper, "Force re-fetch");
    expect(calls).toEqual([["planSync", false], ["discardPlan"], ["planSync", true]]);
  });

  it("gates replacing local edits behind an acknowledgement", async () => {
    const { wrapper } = await mountSync([{ items: [item("tidy", { state: "drifted" })], upToDate: [], unmanaged: [] }]);
    expect(wrapper.find(".sync__warning").text()).toBe("tidy has local edits; syncing replaces them with the catalog's copy.");
    const sync = () => wrapper.findAll("button").find((b) => b.text() === "Sync 1")!;
    expect(sync().attributes("disabled")).toBeDefined();
    await wrapper.find(".sync__ack input").setValue(true);
    expect(sync().attributes("disabled")).toBeUndefined();
  });

  it("reports failures verbatim, receipts gone from disk with what to do, dependencies it installed, and counts touched files as updated", async () => {
    const gone = receipt({ type: "skill", name: "old", catalog: "team", source: "s" });
    const { wrapper } = await mountSync([{ items: [item("tidy"), item("same", { preview: files() })], upToDate: [], unmanaged: [] }], {
      applySync: async () =>
        ok({
          synced: [
            { ...ref("tidy"), dest: "/d/tidy", preview: files({ modified: ["SKILL.md"], added: ["new.md"] }) },
            { ...ref("same"), dest: "/d/same", preview: files() },
          ],
          upToDate: [],
          failed: [{ ...ref("lint"), reason: "clone failed for acme/skills: Permission denied (publickey)." }],
          dependencies: [{ ...ref("base"), requiredBy: ["tidy"] }],
          unmanaged: [],
          missing: [gone],
        }),
    });
    await press(wrapper, "Sync 2");
    expect(summary(wrapper)).toBe("1 updated · 0 already up to date · 1 failed · 1 gone from disk");
    expect(wrapper.find(".sync__item--error .sync__detail").text()).toBe("clone failed for acme/skills: Permission denied (publickey).");
    expect(wrapper.find(".sync__note").text()).toContain("The record was kept and nothing was deleted.");
    expect(wrapper.find(".sync__item--gone .sync__path").text()).toBe(gone.dest);
    expect(wrapper.findAll(".sync__file").map((f) => f.text())).toEqual(["~ SKILL.md", "+ new.md"]);
    expect(wrapper.text()).toContain("was not installed · required by tidy");
  });

  it("drops the report on a failure, and Back closes the view, discarding an unapplied plan", async () => {
    const { wrapper, calls } = await mountSync([{ items: [item("tidy")], upToDate: [], unmanaged: [] }], {
      applySync: async () => ({ ok: false, error: { code: "STALE_PLAN", message: "planned destinations changed" }, warnings: [] }),
    });
    await press(wrapper, "Sync 1");
    expect(wrapper.find(".status-banner--error pre").text()).toBe("planned destinations changed");
    expect(wrapper.find(".sync__summary").exists()).toBe(false);

    await press(wrapper, "Check again");
    useViewStore().sync = true;
    await wrapper.find(".view__head button").trigger("click");
    expect(useViewStore().sync).toBe(false);
    wrapper.unmount();
    await flushPromises();
    expect(calls.at(-1)).toEqual(["discardPlan"]);
  });
});
