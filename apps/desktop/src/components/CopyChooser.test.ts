import type { EntryDetail as Detail, Library } from "@loadout/core";
import { entryRecord, installedRecord, seededState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { mountView } from "../testing/mountView.ts";
import EntryDetail from "./EntryDetail.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const DEST = "/Users/dev/.claude/skills/tidy";
type Assessment = Parameters<Library["applyPin"]>[0]["switch"];

const copies = (pinned = false): Detail["copies"] => [
  { catalog: "personal", wins: !pinned, subject: false, pinned: false, overrides: pinned ? [] : ["team"], overriddenBy: pinned ? "team" : null },
  { catalog: "team", wins: pinned, subject: true, pinned, overrides: pinned ? ["personal"] : [], overriddenBy: pinned ? null : "personal" },
];

function detail(pinned = false): Detail {
  const entry = entryRecord({ name: "tidy", catalog: "team", overriddenBy: pinned ? null : "personal" });
  return {
    name: "tidy",
    entry,
    copies: copies(pinned),
    requires: [],
    unresolvedRequires: [],
    dependents: [],
    installs: [],
    source: { raw: entry.source, kind: "unknown", error: "" },
  };
}

function assessment(extra: Partial<Assessment> = {}): Assessment {
  return { switchable: false, simple: false, stale: [], blockers: [], unresolvedRequires: [], newDependencies: [], dependents: [], ...extra };
}

const stale = { dest: DEST, state: "installed" as const, from: "personal" };

/** The entry page on team's copy of tidy, over a fake recording each pin op. */
async function mountPage(assessed: Assessment, extra: Partial<Library> = {}, pinned = false) {
  const calls: unknown[][] = [];
  const plan = (catalog: string) => ({ name: "tidy", catalog, previous: null, holders: ["personal", "team"], onlyHolder: false, switch: assessed });
  const mounted = mountView(EntryDetail, {
    seed: { ...seededState(), entries: [installedRecord("installed", { name: "tidy" }), entryRecord({ name: "tidy", catalog: "team", overriddenBy: "personal" })] },
    props: { stop: { name: "tidy", catalog: "team" }, back: "Loadout" },
    library: {
      show: async () => ok(detail(pinned)),
      planPin: async (req) => (calls.push(["planPin", req]), ok(plan(req.catalog) as never)),
      applyPin: async (p, o) => (calls.push(["applyPin", p.catalog, o.switchInstalled]), ok({ ...p, installed: o.switchInstalled ? { installed: [], stopped: null, aborted: false } : null })),
      unpin: async (name) => (calls.push(["unpin", name]), ok({ name, was: "team", resolvesTo: "personal" })),
      ...extra,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};
const buttons = (w: Wrapper, selector: string) => w.findAll(`${selector} button`).map((b) => b.text());

describe("UI-30: pinning", () => {
  it("offers each copy a verb in its head: pin the winner, use the other", async () => {
    const { wrapper } = await mountPage(assessment());
    expect(wrapper.findAll(".entry-detail__choose").map((b) => [b.text(), b.classes("btn-sm")])).toEqual([
      ["Pin to this", true],
      ["Use this one", true],
    ]);
    expect(wrapper.find(".entry-detail__choose").attributes("title")).toBe("Already what installs. Pinning keeps it that way if the catalog order changes.");
  });

  it("pins straight through when no copy from elsewhere is installed", async () => {
    const { wrapper, calls } = await mountPage(assessment());
    await press(wrapper, "Use this one");
    expect(calls).toEqual([
      ["planPin", { name: "tidy", catalog: "team" }],
      ["applyPin", "team", false],
    ]);
    expect(wrapper.find(".entry-detail__propose").exists()).toBe(false);
  });

  it("asks first when the pin would leave another catalog's copy installed, naming it, what else installs, and who expects it", async () => {
    const { wrapper, calls } = await mountPage(
      assessment({ switchable: true, simple: true, stale: [stale], newDependencies: ["lint"], dependents: [{ name: "deploy", catalog: "personal", direct: true }] }),
    );
    await press(wrapper, "Use this one");
    expect(calls).toEqual([["planPin", { name: "tidy", catalog: "team" }]]);
    const asked = wrapper.find(".entry-detail__propose").text().replace(/\s+/g, " ");
    expect(asked).toContain("Pinning to team affects 1 installed copy:");
    expect(asked).toContain(`${DEST} — installed, from personal`);
    expect(asked).toContain("Switching also installs lint, which the team copy requires.");
    expect(asked).toContain("Still expected by deploy");
    expect(buttons(wrapper, ".entry-detail__propose-actions")).toEqual(["Pin and switch the files over", "Pin only, leave the files", "Cancel"]);
  });

  it("switches the files over only once confirmed, and says what it overwrote", async () => {
    const { wrapper, calls } = await mountPage(assessment({ switchable: true, simple: true, stale: [stale] }));
    await press(wrapper, "Use this one");
    await press(wrapper, "Pin and switch the files over");
    expect(calls.at(-1)).toEqual(["applyPin", "team", true]);
    expect(wrapper.find(".entry-detail__switch-lede").text().replace(/\s+/g, " ")).toBe("Switched 1 copy over to team, overwriting what was installed.");
    expect(wrapper.find(".entry-detail__propose").exists()).toBe(false);
  });

  it("can pin without touching the files, and says nothing was overwritten", async () => {
    const { wrapper, calls } = await mountPage(assessment({ switchable: true, simple: true, stale: [stale] }));
    await press(wrapper, "Use this one");
    await press(wrapper, "Pin only, leave the files");
    expect(calls.at(-1)).toEqual(["applyPin", "team", false]);
    expect(wrapper.find(".status-banner--warning").text()).toContain("Nothing was overwritten.");
  });

  it("doesn't offer the switch when something needs a decision, and lists why", async () => {
    const { wrapper } = await mountPage(assessment({ switchable: true, simple: false, stale: [{ ...stale, state: "drifted" }], blockers: [`${DEST} has edits Loadout didn't make`] }));
    await press(wrapper, "Use this one");
    expect(wrapper.find(".entry-detail__propose").text()).toContain("has edits Loadout didn't make");
    expect(buttons(wrapper, ".entry-detail__propose-actions")).toEqual(["Pin only, leave the files", "Cancel"]);
  });

  it("leaves the config and the files alone on Cancel", async () => {
    const { wrapper, calls } = await mountPage(assessment({ switchable: true, simple: true, stale: [stale] }));
    await press(wrapper, "Use this one");
    await press(wrapper, "Cancel");
    expect(calls).toEqual([["planPin", { name: "tidy", catalog: "team" }]]);
    expect(wrapper.find(".entry-detail__propose").exists()).toBe(false);
  });

  it("shows a refused pin without claiming the choice was made", async () => {
    const { wrapper } = await mountPage(assessment(), { planPin: async () => ({ ok: false, error: { code: "REFUSED", message: "'tidy' is not in catalog 'team'" }, warnings: [] }) });
    await press(wrapper, "Use this one");
    expect(wrapper.find(".status-banner--error pre").text()).toBe("'tidy' is not in catalog 'team'");
    expect(wrapper.find(".status-banner--success").exists()).toBe(false);
  });

  it("unpins from the page and says what installs now", async () => {
    const { wrapper, calls } = await mountPage(assessment(), {}, true);
    expect(wrapper.findAll(".entry-detail__choose").map((b) => b.text())).toEqual(["Use this one", "Clear pin"]);
    await press(wrapper, "Clear pin");
    expect(calls).toEqual([["unpin", "tidy"]]);
    expect(wrapper.find(".status-banner--success").text()).toBe("Unpinned tidy. Catalog order decides it again, so personal's copy is what installs.");
  });
});
