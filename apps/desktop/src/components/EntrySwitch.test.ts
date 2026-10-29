import type { Library } from "@loadout/core";
import { catalogRow, entryRecord, installedRecord, type FakeState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { SESSION_TIMING } from "../catalog.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useToastStore } from "../stores/toasts.ts";
import { mountView } from "../testing/mountView.ts";
import CatalogView from "./CatalogView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });

/** The list over a fake whose setSkillState writes `disabled` into its own state, as the core's would. */
async function mountList(entries: FakeState["entries"], library: Partial<Library> = {}) {
  const calls: [string[], string][] = [];
  const mounted = mountView(CatalogView, {
    seed: { catalogs: [catalogRow()], entries },
    library: {
      setSkillState: async (names: string[], state: "on" | "off") => {
        calls.push([names, state]);
        // the seed's own records: the fake serves these objects, so writing them is what a reload reads
        const target = entries.find((e) => e.name === names[0])!;
        const changed = target.disabled !== (state === "off");
        target.disabled = state === "off";
        return ok({ changed: changed ? [{ name: target.name, type: target.type, state }] : [], unchanged: changed ? [] : [target.name], readOnly: [] });
      },
      ...library,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountList>>["wrapper"];
const switchFor = (w: Wrapper, name: string) => w.find(`[role=switch][aria-label='${name} enabled']`);
const messages = () => useToastStore().toasts.map((t) => [t.kind, t.message, t.detail]);

describe("UI-20: the on/off switch", () => {
  it("is offered on the winning installed copy of a skill or prompt, unmanaged included; never an agent or an absent copy", async () => {
    const { wrapper } = await mountList([
      installedRecord("installed", { name: "skill" }),
      installedRecord("unmanaged", { name: "by-hand" }),
      installedRecord("installed", { type: "prompt", name: "prompt" }),
      installedRecord("installed", { type: "agent", name: "agent" }),
      entryRecord({ name: "absent" }),
    ]);
    expect(wrapper.findAll("[role=switch]").map((s) => s.attributes("aria-label"))).toEqual(["skill enabled", "by-hand enabled", "prompt enabled"]);
    // inside the card, beside the open button rather than in it
    expect(wrapper.find(".entry-list__open [role=switch]").exists()).toBe(false);
  });

  it("turns a skill off: the switch moves at once, goes inert until the call returns, then a toast says when it lands", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { wrapper, calls, library } = await mountList([installedRecord("installed", { name: "tidy" })]);
    const write = library.setSkillState;
    library.setSkillState = async (names, state) => (await gate, write(names, state));

    await switchFor(wrapper, "tidy").trigger("click");
    expect(switchFor(wrapper, "tidy").attributes("aria-checked")).toBe("false");
    expect(switchFor(wrapper, "tidy").attributes("disabled")).toBeDefined();

    release();
    await flushPromises();
    expect(calls).toEqual([[["tidy"], "off"]]);
    expect(switchFor(wrapper, "tidy").attributes("aria-checked")).toBe("false");
    expect(switchFor(wrapper, "tidy").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".entry-list__status").text()).toBe("disabled");
    expect(messages()).toEqual([["success", `tidy is switched off. ${SESSION_TIMING}`, undefined]]);
  });

  it("turns a prompt back on, and an already-on result still counts as success", async () => {
    const { wrapper, calls } = await mountList([installedRecord("installed", { type: "prompt", name: "standup", disabled: true })]);
    await switchFor(wrapper, "standup").trigger("click");
    await flushPromises();
    expect(calls).toEqual([[["standup"], "on"]]);
    expect(switchFor(wrapper, "standup").attributes("aria-checked")).toBe("true");
    expect(messages()[0]![0]).toBe("success");
  });

  it("snaps back when the write is refused, and says why in an error toast", async () => {
    const { wrapper } = await mountList([installedRecord("installed", { name: "tidy" })], {
      setSkillState: async () => ({ ok: false, error: { code: "SETTINGS", message: "settings.json is not valid JSON" }, warnings: [] }),
    });
    await switchFor(wrapper, "tidy").trigger("click");
    await flushPromises();
    expect(switchFor(wrapper, "tidy").attributes("aria-checked")).toBe("true");
    expect(messages()).toEqual([["error", "Could not switch tidy.", "settings.json is not valid JSON"]]);
  });

  it("shows a name-only or user-invocable-only value set elsewhere, and offers no switch for it", async () => {
    const { wrapper } = await mountList([
      installedRecord("installed", { name: "quiet", skillOverride: "name-only" }),
      installedRecord("installed", { type: "prompt", name: "manual", skillOverride: "user-invocable-only" }),
    ]);
    expect(wrapper.findAll("[role=switch]")).toEqual([]);
    expect(wrapper.findAll(".entry-list__visibility").map((p) => [p.text(), p.attributes("title")])).toEqual([
      ["name-only", "Set to name-only in Claude Code's settings; Loadout leaves it as it is."],
      ["user-invocable-only", "Set to user-invocable-only in Claude Code's settings; Loadout leaves it as it is."],
    ]);
  });

  it("says so when the value was changed elsewhere to one Loadout leaves alone", async () => {
    const { wrapper } = await mountList([installedRecord("installed", { name: "tidy" })], {
      setSkillState: async () => ok({ changed: [], unchanged: [], readOnly: [{ name: "tidy", value: "name-only" }] }),
    });
    await switchFor(wrapper, "tidy").trigger("click");
    await flushPromises();
    expect(switchFor(wrapper, "tidy").attributes("aria-checked")).toBe("true");
    expect(messages()).toEqual([["error", "Could not switch tidy.", "It is set to name-only elsewhere; Loadout leaves that as it is."]]);
  });
});
