import type { Library } from "@loadout/core";
import { loadoutRecord, seededState, type FakeState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useToastStore } from "../stores/toasts.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import LoadoutsView from "./LoadoutsView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
type SaveReq = Parameters<Library["planSaveLoadout"]>[0];
type Build = Extract<Awaited<ReturnType<Library["applySaveLoadout"]>>, { ok: true }>["value"]["build"];
const member = (name: string, state: "built" | "stale" | "missing" | "failed" = "built", catalog?: string) => ({
  type: "skill" as const,
  name,
  resolvesTo: "team",
  state,
  ...(catalog !== undefined && { catalog }),
});

/**
 * The view over seededState()'s catalog, with saves and deletes modelled on the fake's own state, so the
 * list reloads into what they did. `build` is what each save reports.
 */
async function mountLoadouts(seed: Partial<FakeState> = {}, extra: Partial<Library> = {}, build: Partial<Build> = {}) {
  const saves: SaveReq[] = [];
  const deletes: string[] = [];
  const library: Partial<Library> = {
    planSaveLoadout: async (req) => (saves.push(req), ok({ ...req, previous: null, unknown: [] } as never)),
    applySaveLoadout: async (plan) => {
      const { name, members } = plan as unknown as SaveReq;
      const saved = loadoutRecord({ name, members: members.map((m) => ({ ...m, resolvesTo: m.catalog ?? "team", state: "built" as const })) });
      mounted.library.state.loadouts = [...mounted.library.state.loadouts.filter((l) => l.name !== name), saved];
      const built = members.map((m) => ({ type: m.type, name: m.name, dest: `/l/${name}/${m.name}`, requiredBy: [] }));
      return ok({ ...saved, build: { built, failed: [], removed: [], ...build } });
    },
    planDeleteLoadout: async (name) => (deletes.push(name), ok({ name, previous: { members: [] }, folder: `/l/${name}` } as never)),
    applyDeleteLoadout: async (plan) => {
      const { name } = plan as unknown as { name: string };
      mounted.library.state.loadouts = mounted.library.state.loadouts.filter((l) => l.name !== name);
      return ok({ name, removedFolder: true });
    },
    launchCommand: async (name) => ok({ name, run: `loadout run ${name}`, command: "c", clashes: [] }),
    ...extra,
  };
  const mounted = mountView(LoadoutsView, { seed: { ...seededState(), ...seed }, library });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, saves, deletes };
}

type Wrapper = Awaited<ReturnType<typeof mountLoadouts>>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  const button = w.findAll("button").find((b) => b.text() === label);
  if (!button) throw new Error(`no button "${label}" in: ${w.findAll("button").map((b) => b.text()).join(" | ")}`);
  await button.trigger("click");
  await flushPromises();
};
const card = (w: Wrapper, name: string) => w.findAll(".loadouts__item").find((i) => i.find(".loadouts__name").text() === name)!;
const banner = (w: Wrapper) => w.find(".status-banner");
const candidates = (w: Wrapper) => w.findAll(".loadout-editor__candidate").map((c) => c.find(".loadout-editor__name").text());
const memberRow = (w: Wrapper, name: string) => w.findAll(".loadout-editor__member").find((m) => m.find(".loadout-editor__name").text() === name)!;
const addCandidate = async (w: Wrapper, name: string, catalog: string) => {
  const row = w.findAll(".loadout-editor__candidate").find((c) => c.find(".loadout-editor__name").text() === name && c.text().includes(catalog))!;
  await row.find("button").trigger("click");
  await flushPromises();
};
const typeName = async (w: Wrapper, name: string) => {
  await w.find("#loadout-name").setValue(name);
  await flushPromises();
};
const search = async (w: Wrapper, query: string) => {
  await w.find(".loadout-editor input[type=search]").setValue(query);
  await flushPromises();
};

describe("Loadouts", () => {
  it("lists each loadout with its member count and state, and offers Sync for one that is behind", async () => {
    const { wrapper } = await mountLoadouts({
      loadouts: [
        loadoutRecord({ name: "docs", members: [member("a", "stale"), member("b", "missing"), member("c")] }),
        loadoutRecord({ name: "review", members: [member("lint"), member("notes")] }),
      ],
    });

    expect(card(wrapper, "review").find(".loadouts__summary").text()).toBe("2 members · all built");
    expect(card(wrapper, "review").find(".loadouts__stale").exists()).toBe(false);
    expect(card(wrapper, "docs").find(".loadouts__summary").text()).toBe("3 members · 1 out of date · 1 not built");
    await card(wrapper, "docs").find(".loadouts__stale button").trigger("click");
    expect(useViewStore().sync).toBe(true);
  });

  it("says when there are none yet", async () => {
    const { wrapper } = await mountLoadouts({ loadouts: [] });
    expect(wrapper.find(".loadouts__empty").text()).toContain("No loadouts yet");
  });

  it("creates one from the catalog: checks the name as it's typed, searches and filters, shows what a member adds, and saves", async () => {
    const { wrapper, saves } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "docs" })] });
    await press(wrapper, "New loadout");
    const save = () => wrapper.findAll(".loadout-editor__actions button").find((b) => b.text() === "Save")!;

    await typeName(wrapper, "My Kit");
    expect(wrapper.find(".loadout-editor__help--error").text()).toBe("Use lowercase letters and digits, with single hyphens between them.");
    await typeName(wrapper, "docs");
    expect(wrapper.find(".loadout-editor__help--error").text()).toBe("A loadout named docs already exists.");
    expect(save().attributes("disabled")).toBeDefined();
    await typeName(wrapper, "kit");
    expect(wrapper.find(".loadout-editor__help--error").exists()).toBe(false);

    await search(wrapper, "tid");
    expect(candidates(wrapper)).toEqual(["tidy"]);
    await addCandidate(wrapper, "tidy", "team");
    expect(memberRow(wrapper, "tidy").find(".loadout-editor__adds").text()).toBe("Adds lint for it.");
    await search(wrapper, "");
    await wrapper.find(".loadout-editor select").setValue("prompt");
    expect(candidates(wrapper)).toEqual(["standup"]);
    await wrapper.find(".loadout-editor select").setValue("all");
    await search(wrapper, "review");
    expect(candidates(wrapper)).toEqual(["review", "review", "reviewer"]);
    await addCandidate(wrapper, "review", "team");

    await press(wrapper, "Save");

    expect(saves).toEqual([{ name: "kit", members: [{ type: "skill", name: "tidy" }, { type: "skill", name: "review", catalog: "team" }] }]);
    expect(banner(wrapper).text()).toBe("Saved kit: 2 entries built.");
    expect(wrapper.find(".loadout-editor").exists()).toBe(false);
    expect(card(wrapper, "kit").exists()).toBe(true);
  });

  it("edits one: the name stays, a member can go, and saving replaces it", async () => {
    const { wrapper, saves } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint", "built", "team"), member("notes")] })] });
    await card(wrapper, "review").findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
    await flushPromises();

    expect(wrapper.find("#loadout-name").attributes("disabled")).toBeDefined();
    await memberRow(wrapper, "lint").find("button").trigger("click");
    await press(wrapper, "Save");

    expect(saves).toEqual([{ name: "review", members: [{ type: "skill", name: "notes" }], replace: true }]);
    expect(banner(wrapper).text()).toBe("Saved review: 1 entry built.");
  });

  it("deletes one only after asking", async () => {
    const { wrapper, deletes } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review" }), loadoutRecord({ name: "docs" })] });
    const del = () => card(wrapper, "review").findAll("button").find((b) => b.text() === "Delete")!;

    await del().trigger("click");
    expect(card(wrapper, "review").find(".loadouts__confirm").text()).toContain("Delete review?");
    await press(wrapper, "Cancel");
    expect(wrapper.find(".loadouts__confirm").exists()).toBe(false);
    expect(deletes).toEqual([]);

    await del().trigger("click");
    await press(wrapper, "Delete review");

    expect(deletes).toEqual(["review"]);
    expect(banner(wrapper).text()).toBe("Deleted review.");
    expect(wrapper.findAll(".loadouts__name").map((n) => n.text())).toEqual(["docs"]);
  });

  describe("copying", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });
    afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

    it("copies loadout run, or the bare command for a .dmg install", async () => {
      const review = loadoutRecord({ name: "review" });
      const { wrapper } = await mountLoadouts({ loadouts: [review] });

      await press(wrapper, "Copy loadout run");
      await press(wrapper, "Copy command for a .dmg install");

      expect(writeText.mock.calls).toEqual([[review.run], [review.command]]);
      expect(useToastStore().toasts.map((t) => [t.kind, t.message, t.detail])).toEqual([
        ["success", "Copied", review.run],
        ["success", "Copied", review.command],
      ]);
    });
  });

  it("shows what a session makes of a member that clashes", async () => {
    const asked: unknown[][] = [];
    const { wrapper } = await mountLoadouts({ loadouts: [] }, {
      launchCommand: async (name, opts) => {
        asked.push([name, opts?.members]);
        const clashes = (opts?.members ?? []).map((m) => ({ ...m, with: "skill" as const, outcome: "prefixed" as const, sessionName: `${name}:${m.name}` }));
        return ok({ name, run: "r", command: "c", clashes });
      },
    });
    await press(wrapper, "New loadout");
    await typeName(wrapper, "kit");
    await search(wrapper, "tid");
    await addCandidate(wrapper, "tidy", "team");

    expect(memberRow(wrapper, "tidy").find(".loadout-editor__clash").text()).toBe("Your global skill keeps /tidy; in a session this one is /kit:tidy.");
    expect(asked.at(-1)).toEqual(["kit", [{ type: "skill", name: "tidy" }]]);
  });

  it("keeps a loadout whose build failed and says what didn't build", async () => {
    const { wrapper } = await mountLoadouts({ loadouts: [] }, {}, { failed: [{ type: "skill", name: "tidy", requiredBy: [], reason: "clone failed: Permission denied" }] });
    await press(wrapper, "New loadout");
    await typeName(wrapper, "kit");
    await search(wrapper, "tid");
    await addCandidate(wrapper, "tidy", "team");

    await press(wrapper, "Save");

    expect(banner(wrapper).classes()).toContain("status-banner--warning");
    expect(banner(wrapper).text()).toContain("Saved kit, but 1 entry didn't build.");
    expect(banner(wrapper).find(".status-banner__detail").text()).toBe("tidy: clone failed: Permission denied");
    expect(card(wrapper, "kit").exists()).toBe(true);
  });
});
