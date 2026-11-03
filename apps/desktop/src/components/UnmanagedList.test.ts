import { err, type Library } from "@loadout/core";
import { scanItem, seededState, type FakeState } from "@loadout/core/testing";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TIMING, unloadableReason, unmanagedOrigin } from "../catalog.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useToastStore } from "../stores/toasts.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import CatalogView from "./CatalogView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });

/** The list, browsing Unmanaged, over seededState() unless the test seeds its own scan. */
async function mountUnmanaged(seed: Partial<FakeState> = {}, library: Partial<Library> = {}) {
  const mounted = mountView(CatalogView, { seed: { ...seededState(), ...seed }, library });
  await useCatalogStore().reload();
  await flushPromises();
  await mounted.wrapper.findAll(".sidebar__item").find((b) => b.text().startsWith("Unmanaged"))!.trigger("click");
  await flushPromises();
  return mounted;
}

type Wrapper = Awaited<ReturnType<typeof mountUnmanaged>>["wrapper"];
const item = (w: Wrapper, name: string) => w.findAll(".unmanaged__item").find((i) => i.find(".unmanaged__name").text() === name)!;
const pressed = (w: Wrapper) => w.find(".sidebar__item[aria-pressed=true]").findAll("span").map((t) => t.text()).join(" ");
const names = (w: Wrapper) => w.findAll(".unmanaged__name").map((n) => n.text());
const messages = () => useToastStore().toasts.map((t) => [t.kind, t.message, t.detail]);

describe("unmanaged wording", () => {
  it("says where each item came from", () => {
    const npx = { tool: "npx skills", source: "vercel-labs/skills", installedAt: "2026-09-25T17:35:14.235Z", updatedAt: null };
    const link = { target: "/Users/dev/.agents/skills/find-skills", kind: "dir" as const };
    expect(unmanagedOrigin(scanItem({ attribution: npx, link }))).toBe("From npx skills · vercel-labs/skills · installed 2026-09-25");
    expect(unmanagedOrigin(scanItem({ attribution: { ...npx, source: null, installedAt: null } }))).toBe("From npx skills");
    expect(unmanagedOrigin(scanItem({ attribution: { tool: "a tool from next year", source: null, installedAt: null, updatedAt: null } }))).toBe(
      "From a tool from next year",
    );
    expect(unmanagedOrigin(scanItem({ link: { target: "/tools/library", kind: "dir" } }))).toBe("Linked to /tools/library");
    expect(unmanagedOrigin(scanItem({ link: { target: null, broken: true } }))).toBe("A link to something that is gone");
    expect(unmanagedOrigin(scanItem({ state: { state: "unmanaged", origin: "python-cli" } }))).toBe("Installed by the old Python CLI");
    expect(unmanagedOrigin(scanItem({ state: { state: "unmanaged", origin: "python-cli-edited" } }))).toBe("Edited since the Python CLI installed it");
    expect(unmanagedOrigin(scanItem())).toBe("Added by hand or by another tool");
  });

  it("says why Claude Code can't load an item, and nothing when it can", () => {
    expect(unloadableReason(scanItem())).toBeNull();
    expect(unloadableReason(scanItem({ link: { target: null, broken: true }, loadable: false }))).toBe("Claude Code can't load this: the link points at nothing.");
    expect(unloadableReason(scanItem({ link: { target: "/f.md", kind: "file" }, loadable: false }))).toBe(
      "Claude Code can't load this: a skill is a folder, and this links to a file.",
    );
    expect(unloadableReason(scanItem({ type: "agent", link: { target: "/d", kind: "dir" }, loadable: false }))).toBe(
      "Claude Code can't load this: it should be an .md file, and this links to a folder.",
    );
  });
});

describe("Unmanaged in the sidebar", () => {
  afterEach(() => clearMocks());

  it("counts what Loadout didn't install, without the Python CLI's parked copies", async () => {
    const parked = scanItem({ name: "parked", state: { state: "unmanaged", origin: "parked-by-python-cli" }, loadable: false });
    const { wrapper } = await mountUnmanaged({ scanned: [...seededState().scanned, parked] });
    expect(pressed(wrapper)).toBe("Unmanaged 6");
    expect(wrapper.find("h1").text()).toBe("Unmanaged");
    expect(names(wrapper)).not.toContain("parked");
  });

  it("groups by type, each with its path and origin, and hides the catalog filters", async () => {
    const { wrapper } = await mountUnmanaged();
    expect(wrapper.findAll(".unmanaged__label").map((l) => l.text())).toEqual(["Skills", "Prompts", "Agents"]);
    expect(names(wrapper)).toEqual(["find-skills", "grill", "neo", "gone", "team", "helper"]);
    expect(item(wrapper, "find-skills").find(".unmanaged__path").text()).toBe("/Users/dev/.claude/skills/find-skills");
    expect(item(wrapper, "find-skills").find(".unmanaged__origin").text()).toBe("From npx skills · vercel-labs/skills · installed 2026-09-25");
    expect(item(wrapper, "helper").find(".unmanaged__origin").text()).toBe("Installed by the old Python CLI");
    expect(wrapper.find(".toolbar").exists()).toBe(false);
  });

  it("says when Claude Code can't load one, and offers no switch on it, an agent or a prompt namespace", async () => {
    const { wrapper } = await mountUnmanaged();
    expect(item(wrapper, "gone").find(".unmanaged__warning").text()).toBe("Claude Code can't load this: the link points at nothing.");
    expect(item(wrapper, "find-skills").find(".unmanaged__warning").exists()).toBe(false);
    const switches = wrapper.findAll("[role=switch]").map((s) => s.attributes("aria-label"));
    expect(switches).toEqual(["find-skills enabled", "grill enabled", "neo enabled"]);
    expect(item(wrapper, "neo").find("[role=switch]").attributes("aria-checked")).toBe("false");
  });

  it("offers no switch on one set to a value Loadout leaves alone", async () => {
    const { wrapper } = await mountUnmanaged({ scanned: [scanItem({ name: "quiet", skillOverride: "name-only" })] });
    expect(wrapper.find("[role=switch]").exists()).toBe(false);
  });

  it("links one sharing a catalog entry's name to that entry's page", async () => {
    const { wrapper } = await mountUnmanaged();
    const shared = item(wrapper, "grill").find(".unmanaged__shared");
    expect(shared.text()).toContain("Shares a name with team's skill; installing it asks before replacing this.");
    expect(item(wrapper, "find-skills").find(".unmanaged__shared").exists()).toBe(false);
    await shared.find("button").trigger("click");
    expect(useViewStore().current).toMatchObject({ kind: "entry", stop: { name: "grill", catalog: "team" } });
  });

  it("switches one off, says when it lands, and reads the scan again", async () => {
    const state = { ...seededState(), scanned: [scanItem({ name: "loose" })] };
    const calls: [string[], string][] = [];
    const { wrapper } = await mountUnmanaged(state, {
      setSkillState: async (n: string[], s: "on" | "off") => {
        calls.push([n, s]);
        // the seed's own item: the fake serves this object, so writing it is what a reload reads
        state.scanned[0]!.disabled = s === "off";
        return ok({ changed: [{ name: n[0]!, type: "skill" as const, state: s }], unchanged: [], readOnly: [] });
      },
    });
    await wrapper.find("[role=switch]").trigger("click");
    await flushPromises();
    expect(calls).toEqual([[["loose"], "off"]]);
    expect(messages()).toContainEqual(["success", `loose is switched off. ${SESSION_TIMING}`, undefined]);
    expect(wrapper.find("[role=switch]").attributes("aria-checked")).toBe("false");
    expect(wrapper.find(".unmanaged__item--off").exists()).toBe(true);
    expect(wrapper.find(".unmanaged__status").text()).toBe("disabled");
    expect(wrapper.find(".unmanaged__status").attributes("title")).toBe(SESSION_TIMING);
  });

  it("badges only what is switched off", async () => {
    const { wrapper } = await mountUnmanaged();
    expect(wrapper.findAll(".unmanaged__item").filter((i) => i.find(".unmanaged__status").exists()).map((i) => i.find(".unmanaged__name").text())).toEqual(["neo"]);
  });

  it("says why a switch failed", async () => {
    const { wrapper } = await mountUnmanaged({ scanned: [scanItem({ name: "loose" })] }, {
      setSkillState: async () => err({ code: "SETTINGS", message: "settings.json is read-only" }),
    });
    await wrapper.find("[role=switch]").trigger("click");
    await flushPromises();
    expect(messages()).toContainEqual(["error", "Could not switch loose.", "settings.json is read-only"]);
  });

  it("reveals the item itself in Finder", async () => {
    const ipc: [string, unknown][] = [];
    mockIPC((cmd, payload) => void ipc.push([cmd, payload]));
    const { wrapper } = await mountUnmanaged();
    await item(wrapper, "find-skills").find(".unmanaged__reveal").trigger("click");
    await flushPromises();
    expect(ipc).toContainEqual(["plugin:opener|reveal_item_in_dir", { paths: ["/Users/dev/.claude/skills/find-skills"] }]);
  });

  it("searches by name, and offers to clear a search that matched nothing", async () => {
    const { wrapper } = await mountUnmanaged();
    await wrapper.find("input[type=search]").setValue("gr");
    expect(names(wrapper)).toEqual(["grill"]);
    await wrapper.find("input[type=search]").setValue("zzz");
    expect(wrapper.find(".state__line").text()).toBe("Nothing here matches zzz.");
    await wrapper.findAll("button").find((b) => b.text() === "Clear the search")!.trigger("click");
    expect(names(wrapper)).toHaveLength(6);
  });

  it("says when everything was installed by Loadout", async () => {
    const { wrapper } = await mountUnmanaged({ scanned: [] });
    expect(pressed(wrapper)).toBe("Unmanaged 0");
    expect(wrapper.find(".state__line").text()).toBe("Everything in ~/.claude was installed by Loadout.");
  });

  it("shows a failed scan as its own error, and the catalog still lists", async () => {
    const { wrapper } = await mountUnmanaged({}, { scan: async () => err({ code: "RECEIPTS_INVALID", message: "receipts.json is not valid JSON" }) });
    expect(wrapper.find(".status-banner--error").text()).toContain("Loadout couldn't read what is in ~/.claude.");
    expect(wrapper.find(".status-banner--error").text()).toContain("receipts.json is not valid JSON");
    expect(messages()).toEqual([]);
    await wrapper.findAll(".sidebar__item").find((b) => b.text().startsWith("All"))!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".entry-list__name").length).toBeGreaterThan(0);
  });

  it("goes back to the catalog's entries from any type in Browse", async () => {
    const { wrapper } = await mountUnmanaged();
    await wrapper.findAll(".sidebar__item").find((b) => b.text().startsWith("Prompts"))!.trigger("click");
    await flushPromises();
    expect(wrapper.find("h1").text()).toBe("Prompts");
    expect(wrapper.find(".unmanaged").exists()).toBe(false);
  });
});
