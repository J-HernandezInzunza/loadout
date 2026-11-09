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
const summary = (w: Wrapper, name: string) => card(w, name).findAll(".loadouts__part").map((p) => p.text());
const banner = (w: Wrapper) => w.find(".status-banner");
const candidates = (w: Wrapper) => w.findAll(".loadout-editor__candidate").map((c) => c.find(".loadout-editor__name").text());
const memberRow = (w: Wrapper, name: string) => w.findAll(".loadout-editor__member").find((m) => m.find(".loadout-editor__name").text() === name)!;
const column = (w: Wrapper, type: string) => w.find(`.loadout-editor .type-column--${type}`);
/** Each editor column's title, count and member names, in order. */
const columns = (w: Wrapper) =>
  w.findAll(".loadout-editor .type-column").map((c) => [
    c.find(".type-column__title").text(),
    c.find(".type-column__count").text(),
    c.findAll(".loadout-editor__member .loadout-editor__name").map((n) => n.text()),
  ]);
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
  it("lists each loadout with its member count and state, and offers Sync only on one that's behind", async () => {
    const { wrapper } = await mountLoadouts({
      loadouts: [
        loadoutRecord({ name: "docs", members: [member("a", "stale"), member("b", "missing"), member("c")] }),
        loadoutRecord({ name: "review", members: [member("lint"), member("notes")] }),
      ],
    });

    expect(summary(wrapper, "review")).toEqual(["2 skills", "all built"]);
    expect(card(wrapper, "review").find(".loadouts__summary .type-dot--skill").exists()).toBe(true);
    expect(card(wrapper, "review").find(".loadouts__stale").exists()).toBe(false);
    expect(card(wrapper, "review").findAll("button").map((b) => b.text())).not.toContain("Sync");
    expect(summary(wrapper, "docs")).toEqual(["3 skills", "1 out of date", "1 not built"]);
    expect(card(wrapper, "docs").find(".loadouts__stale").text()).toContain("Sync rebuilds them.");
    expect(card(wrapper, "docs").find(".loadouts__stale button").text()).toBe("Sync");
  });

  it("syncs one loadout from its card, alone, and says what changed", async () => {
    const asked: unknown[] = [];
    const synced = (name: string, type: "skill" | "prompt", dest: string) => ({ type, name, catalog: "team", dest, preview: { kind: "destination-only" as const } });
    const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint", "stale")] }), loadoutRecord({ name: "docs" })] }, {
      planSync: async (req) => (asked.push(req), ok({ items: [], upToDate: [], unmanaged: [], loadouts: [], opDir: "/tmp/op", fingerprint: "f" } as never)),
      applySync: async () =>
        ok({
          synced: [],
          upToDate: [],
          failed: [],
          dependencies: [],
          unmanaged: [],
          missing: [],
          loadouts: [
            {
              name: "review",
              synced: [synced("lint", "skill", "/l/review/.claude/skills/lint"), synced("standup", "prompt", "/l/review/.claude/commands/review/standup.md")],
              upToDate: [],
              failed: [],
              removed: [{ type: "prompt", name: "standup", dest: "/l/review/.claude/commands/standup.md" }],
            },
          ],
        }),
    });

    await card(wrapper, "review").findAll("button").find((b) => b.text() === "Sync")!.trigger("click");
    await flushPromises();

    expect(asked).toMatchObject([{ loadout: "review" }]);
    expect(banner(wrapper).text()).toBe("Synced review: 1 updated, 1 moved.");
    expect(useViewStore().sync).toBe(false);
  });

  it("checks for updates and says what it found", async () => {
    const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review" })] });

    await press(wrapper, "Check for updates");

    expect(banner(wrapper).classes()).toContain("status-banner--success");
    expect(banner(wrapper).text()).toBe("Every loadout is up to date.");
  });

  it("claims nothing about updates when the check can't read the loadouts", async () => {
    let reads = 0;
    const { wrapper } = await mountLoadouts({}, {
      loadouts: async () => {
        reads++;
        if (reads === 1) return ok([loadoutRecord({ name: "review" })]);
        return { ok: false as const, error: { code: "REFUSED" as const, message: "config.json is unreadable" }, warnings: [] };
      },
    });

    await press(wrapper, "Check for updates");

    expect(wrapper.findAll(".status-banner").map((b) => b.text())).toEqual([expect.stringContaining("Couldn't read your loadouts.")]);
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

    expect(wrapper.find(".loadout-editor__title").text()).toBe("Edit review");
    expect(wrapper.find("#loadout-name").exists()).toBe(false);
    await memberRow(wrapper, "lint").find("button").trigger("click");
    await press(wrapper, "Save");

    expect(saves).toEqual([{ name: "review", members: [{ type: "skill", name: "notes" }], replace: true }]);
    expect(banner(wrapper).text()).toBe("Saved review: 1 entry built.");
  });

  it("shows a loadout's members in a column per type, and a column's Add narrows the catalog to its type", async () => {
    const standup = { type: "prompt" as const, name: "standup", resolvesTo: "team", state: "built" as const };
    const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint"), standup] })] });
    await card(wrapper, "review").findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
    await flushPromises();
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");

    expect(columns(wrapper)).toEqual([
      ["Skills", "1", ["lint"]],
      ["Agents", "0", []],
      ["Prompts", "1", ["standup"]],
    ]);
    expect(column(wrapper, "agent").find(".type-column__empty").text()).toBe("No agents yet.");

    await column(wrapper, "agent").find(".type-column__head button").trigger("click");
    await flushPromises();
    expect((wrapper.find(".loadout-editor select").element as HTMLSelectElement).value).toBe("agent");
    expect(focus.mock.contexts).toEqual([wrapper.find(".loadout-editor input[type=search]").element]);
    expect(candidates(wrapper)).toEqual(["reviewer"]);
    expect(wrapper.find(".loadout-editor__candidate .type-dot--agent").exists()).toBe(true);

    await addCandidate(wrapper, "reviewer", "team");
    await wrapper.find('[aria-label="Remove lint"]').trigger("click");
    await flushPromises();

    expect(columns(wrapper)).toEqual([
      ["Skills", "0", []],
      ["Agents", "1", ["reviewer"]],
      ["Prompts", "1", ["standup"]],
    ]);
    expect(column(wrapper, "skill").find(".type-column__empty").text()).toBe("No skills yet.");
    expect(column(wrapper, "agent").find(".type-column__empty").exists()).toBe(false);
    focus.mockRestore();
  });

  it("says a draft has unsaved changes until it's back as it opened", async () => {
    const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint"), member("notes")] })] });
    await card(wrapper, "review").findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
    await flushPromises();
    const unsaved = () => wrapper.find(".loadout-editor__unsaved");
    expect(unsaved().exists()).toBe(false);

    await memberRow(wrapper, "notes").find("button").trigger("click");
    expect(unsaved().text()).toBe("Unsaved changes");
    await press(wrapper, "Add from the catalog");
    await search(wrapper, "notes");
    await addCandidate(wrapper, "notes", "personal");
    expect(unsaved().exists()).toBe(false);
    await search(wrapper, "standup");
    await addCandidate(wrapper, "standup", "team");
    expect(unsaved().text()).toBe("Unsaved changes");
  });

  describe("a changed draft", () => {
    // jsdom has <dialog> but not showModal, the call that makes it modal.
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    beforeEach(() => {
      showModal.mockClear();
      HTMLDialogElement.prototype.showModal = showModal;
    });
    afterEach(() => Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"));

    const dialog = (w: Wrapper) => w.find("dialog.confirm-dialog");
    const settle = async () => {
      await vi.dynamicImportSettled();
      await flushPromises();
    };
    /** The editor open on review, with lint removed, on a screen that was opened from the catalog. */
    async function editedReview() {
      const mounted = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint"), member("notes")] })] });
      useViewStore().loadouts = true;
      await card(mounted.wrapper, "review").findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
      await flushPromises();
      await memberRow(mounted.wrapper, "lint").find("button").trigger("click");
      return mounted;
    }

    it("asks in a modal before Cancel throws it away; Keep editing and Escape keep it", async () => {
      const { wrapper, saves } = await editedReview();

      await press(wrapper, "Cancel");
      await settle();
      expect(dialog(wrapper).text()).toContain("Discard your changes to review? The saved loadout stays as it was.");
      expect(showModal.mock.contexts).toEqual([dialog(wrapper).element]);
      await press(wrapper, "Keep editing");
      expect(dialog(wrapper).exists()).toBe(false);
      expect(columns(wrapper)[0]).toEqual(["Skills", "1", ["notes"]]);

      await press(wrapper, "Cancel");
      await settle();
      await dialog(wrapper).trigger("cancel");
      expect(dialog(wrapper).exists()).toBe(false);
      expect(wrapper.find(".loadout-editor").exists()).toBe(true);

      await press(wrapper, "Cancel");
      await settle();
      await press(wrapper, "Discard");
      expect(wrapper.find(".loadout-editor").exists()).toBe(false);
      expect(useViewStore().loadouts).toBe(true);
      expect(saves).toEqual([]);
    });

    it("asks before Back leaves the screen, and Discard leaves it", async () => {
      const { wrapper, saves } = await editedReview();

      await press(wrapper, "← Loadout");
      await settle();
      expect(dialog(wrapper).text()).toContain("Discard your changes to review?");
      expect(useViewStore().loadouts).toBe(true);
      await press(wrapper, "Discard");

      expect(useViewStore().loadouts).toBe(false);
      expect(saves).toEqual([]);
    });

    it("isn't asked about when nothing changed, and is once a new loadout has a name", async () => {
      const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review" })] });
      await card(wrapper, "review").findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
      await flushPromises();
      await press(wrapper, "Cancel");
      expect(wrapper.find(".loadout-editor").exists()).toBe(false);

      await press(wrapper, "New loadout");
      await press(wrapper, "Cancel");
      expect(wrapper.find(".loadout-editor").exists()).toBe(false);

      await press(wrapper, "New loadout");
      await typeName(wrapper, "kit");
      await press(wrapper, "Cancel");
      await settle();
      expect(dialog(wrapper).text()).toContain("Discard this new loadout? Nothing in it has been saved.");
      await press(wrapper, "Keep editing");

      useViewStore().loadouts = true;
      await typeName(wrapper, "");
      await press(wrapper, "← Loadout");
      expect(dialog(wrapper).exists()).toBe(false);
      expect(useViewStore().loadouts).toBe(false);
    });
  });

  describe("peeking", () => {
    const toggle = (w: Wrapper, name: string) => card(w, name).find(".loadouts__peek-toggle");
    const isOpen = (w: Wrapper, name: string) => card(w, name).find(".loadouts__peek").exists();
    /** Each column's title, count, and its members as [name, state shown]. */
    const peek = (w: Wrapper, name: string) =>
      card(w, name)
        .findAll(".loadouts__peek .type-column")
        .map((c) => [
          c.find(".type-column__title").text(),
          c.find(".type-column__count").text(),
          c.findAll(".loadouts__peek-member").map((m) => [m.find(".loadouts__peek-name").text(), m.find(".loadouts__peek-state").exists() ? m.find(".loadouts__peek-state").text() : ""]),
        ]);

    it("opens a card's members by type from its summary, each with its state when it isn't built", async () => {
      const standup = { type: "prompt" as const, name: "standup", resolvesTo: "team", state: "built" as const };
      const { wrapper } = await mountLoadouts({
        loadouts: [loadoutRecord({ name: "docs", members: [member("a", "stale"), member("b", "missing"), member("c", "failed"), standup] }), loadoutRecord({ name: "review" })],
      });
      expect(toggle(wrapper, "docs").attributes("aria-expanded")).toBe("false");
      expect(isOpen(wrapper, "docs")).toBe(false);

      await toggle(wrapper, "docs").trigger("click");
      await flushPromises();

      expect(toggle(wrapper, "docs").attributes("aria-expanded")).toBe("true");
      expect(peek(wrapper, "docs")).toEqual([
        ["Skills", "3", [["a", "out of date"], ["b", "not built"], ["c", "in no catalog"]]],
        ["Agents", "0", []],
        ["Prompts", "1", [["standup", ""]]],
      ]);
      expect(card(wrapper, "docs").find(".loadouts__peek .type-column--agent .type-column__empty").text()).toBe("None.");
      expect(isOpen(wrapper, "review")).toBe(false);

      await toggle(wrapper, "docs").trigger("click");
      expect(isOpen(wrapper, "docs")).toBe(false);
    });

    it("adds each member's clash line once launchCommand answers, asking once per open card per load", async () => {
      const asked: string[] = [];
      const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint"), member("notes")] })] }, {
        launchCommand: async (name) => {
          asked.push(name);
          const clash = { type: "skill" as const, name: "lint", with: "skill" as const, outcome: "prefixed" as const, sessionName: `${name}:lint` };
          return ok({ name, run: `loadout run ${name}`, command: "c", clashes: [clash] });
        },
      });

      await toggle(wrapper, "review").trigger("click");
      await flushPromises();
      const clash = card(wrapper, "review").find(".loadouts__peek .clash-line");
      expect(clash.find(".clash-line__short").text()).toBe("In a session: /review:lint");
      expect(clash.attributes("title")).toBe("Your global skill keeps /lint; in a session this one is /review:lint.");

      await toggle(wrapper, "review").trigger("click");
      await toggle(wrapper, "review").trigger("click");
      await flushPromises();
      expect(asked).toEqual(["review"]);

      await press(wrapper, "Check for updates");
      expect(asked).toEqual(["review", "review"]);
      expect(card(wrapper, "review").find(".loadouts__peek .clash-line").exists()).toBe(true);
    });
  });

  describe("the catalog picker", () => {
    const picker = (w: Wrapper) => w.find(".loadout-editor input[type=search]");

    it("starts closed when editing, opens from its button, stays open while adding, and closes with Close or Escape", async () => {
      const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review", members: [member("lint")] })] });
      await card(wrapper, "review").findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
      await flushPromises();
      expect(picker(wrapper).exists()).toBe(false);

      await press(wrapper, "Add from the catalog");
      expect(picker(wrapper).exists()).toBe(true);
      await search(wrapper, "tid");
      await addCandidate(wrapper, "tidy", "team");
      expect(picker(wrapper).exists()).toBe(true);
      await press(wrapper, "Close");
      expect(picker(wrapper).exists()).toBe(false);

      await press(wrapper, "Add from the catalog");
      await wrapper.find(".loadout-editor__picker").trigger("keydown", { key: "Escape" });
      expect(picker(wrapper).exists()).toBe(false);
      expect(columns(wrapper)[0]).toEqual(["Skills", "2", ["lint", "tidy"]]);
    });

    it("starts open for a new loadout", async () => {
      const { wrapper } = await mountLoadouts({ loadouts: [] });
      await press(wrapper, "New loadout");
      expect(picker(wrapper).exists()).toBe(true);
      expect(wrapper.find("#loadout-name").exists()).toBe(true);
    });
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
    const command = (w: Wrapper) => card(w, "review").find(".loadouts__command code").text();
    const copyButton = (w: Wrapper) => card(w, "review").find(".loadouts__command button");
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });
    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, "clipboard");
    });

    it("shows and copies loadout run when the command is on the PATH, and says Copied in place for a moment", async () => {
      const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review" })], loadoutOnPath: true });
      expect(command(wrapper)).toBe("loadout run review");
      expect(wrapper.find(".loadouts__hint").exists()).toBe(false);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await copyButton(wrapper).trigger("click");
      await flushPromises();

      expect(writeText.mock.calls).toEqual([["loadout run review"]]);
      expect(copyButton(wrapper).text()).toBe("Copied");
      expect(useToastStore().toasts).toEqual([]);
      vi.advanceTimersByTime(1500);
      await flushPromises();
      expect(copyButton(wrapper).text()).toBe("Copy");
    });

    it("shows and copies the bare command when loadout isn't on the PATH, and says how to get the short one", async () => {
      const review = loadoutRecord({ name: "review" });
      const { wrapper } = await mountLoadouts({ loadouts: [review], loadoutOnPath: false });
      expect(command(wrapper)).toBe(review.command);
      expect(wrapper.find(".loadouts__hint").text()).toBe(
        "No loadout command on your PATH, so each card copies the full claude command. Installing Loadout with Homebrew adds the short one.",
      );

      await copyButton(wrapper).trigger("click");
      await flushPromises();

      expect(writeText.mock.calls).toEqual([[review.command]]);
    });

    it("says so in a toast when the clipboard refuses, and keeps the label", async () => {
      writeText.mockRejectedValue(new Error("Write permission denied."));
      const { wrapper } = await mountLoadouts({ loadouts: [loadoutRecord({ name: "review" })] });

      await copyButton(wrapper).trigger("click");
      await flushPromises();

      expect(useToastStore().toasts.map((t) => [t.kind, t.message, t.detail])).toEqual([["error", "Couldn't copy to the clipboard", "Write permission denied."]]);
      expect(copyButton(wrapper).text()).toBe("Copy");
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

    const clash = memberRow(wrapper, "tidy").find(".clash-line");
    const full = "Your global skill keeps /tidy; in a session this one is /kit:tidy.";
    expect(clash.find(".clash-line__short").text()).toBe("In a session: /kit:tidy");
    expect(clash.attributes("title")).toBe(full);
    expect(clash.find(".clash-line__full").text()).toBe(full);
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
