import type { Library } from "@loadout/core";
import { catalogRow, entryRecord, installedRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { mountView } from "../testing/mountView.ts";
import CatalogsView from "./CatalogsView.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const write = { mode: "local" as const, catalog: "personal", changed: true, path: "/Users/dev/catalog/library.yaml", committed: false, pushed: false, branch: null };

async function mountEntries(library: Partial<Library> = {}, entries = [entryRecord({ name: "tidy", description: "Tidies", source: "https://x/SKILL.md", requires: ["skill:lint"] }), entryRecord({ name: "lint" })]) {
  const calls: unknown[][] = [];
  const mounted = mountView(CatalogsView, {
    seed: { catalogs: [catalogRow(), catalogRow({ id: "team", precedence: 2 })], entries },
    props: { at: "personal", back: "Loadout" },
    library: {
      planUpdate: async (req) => (calls.push(["planUpdate", { ...req, signal: undefined }]), ok({ op: "update" } as never)),
      planRemove: async (req) => (calls.push(["planRemove", { ...req, signal: undefined }]), ok({ op: "remove", dependents: req.dryRun ? ["skill:deploy"] : [] } as never)),
      applyCatalogEdit: async (plan) => {
        calls.push(["apply", plan.op]);
        if (plan.op === "update") return ok({ ...write, op: "update" as const, name: "tidy" });
        return ok({ ...write, op: "remove" as const, removed: { type: "skill" as const, name: "tidy" }, dependents: [], deleted: [], diff: "--- library.yaml\n+++ library.yaml\n-  - name: tidy" });
      },
      ...library,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountEntries>>["wrapper"];
const rowButton = (w: Wrapper, name: string, label: string) => w.find(`#entry-${name}`).findAll("button").find((b) => b.text() === label)!;
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};

describe("UI-47: editing an entry", () => {
  it("sends only the fields that changed, and can't save until something has", async () => {
    const { wrapper, calls } = await mountEntries();
    await rowButton(wrapper, "tidy", "Edit").trigger("click");
    expect(wrapper.find(".editor__note").text()).toContain("The name and type cannot be changed here");
    const save = () => wrapper.findAll("button").find((b) => b.text() === "Save changes")!;
    expect(save().attributes("disabled")).toBeDefined();
    expect(wrapper.findAll(".editor__actions button").map((b) => b.text())).toEqual(["Save changes", "Done"]);

    await wrapper.findAll(".editor__field input")[0]!.setValue("Tidies code ");
    expect(wrapper.findAll(".editor__actions button")[1]!.text()).toBe("Cancel");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(calls).toEqual([["planUpdate", { name: "tidy", catalog: "personal", type: "skill", setDescription: "Tidies code", signal: undefined }], ["apply", "update"]]);
    expect(wrapper.find(".editor__saved").text().replace(/\s+/g, " ")).toBe("Updated tidy in personal.");
  });

  it("won't save an empty description or source", async () => {
    const { wrapper } = await mountEntries();
    await rowButton(wrapper, "tidy", "Edit").trigger("click");
    await wrapper.findAll(".editor__field input")[1]!.setValue("  ");
    expect(wrapper.find(".editor__blocked").text()).toBe("An entry needs a description and a source; neither can be left empty.");
    expect(wrapper.findAll("button").find((b) => b.text() === "Save changes")!.attributes("disabled")).toBeDefined();
  });

  it("opens the edit form of the entry it was sent to edit", async () => {
    const mounted = mountView(CatalogsView, {
      seed: { catalogs: [catalogRow()], entries: [entryRecord({ name: "tidy" }), entryRecord({ name: "lint" })] },
      props: { at: "personal", back: "tidy" },
    });
    const { useViewStore } = await import("../stores/views.ts");
    await useCatalogStore().reload();
    useViewStore().manage = { catalog: "personal", entry: "tidy" };
    await flushPromises();
    expect(mounted.wrapper.find("#entry-tidy .editor").exists()).toBe(true);
  });
});

describe("UI-48: removing an entry", () => {
  it("shows the dry run's diff and what still requires it, then removes and says so once the row is gone", async () => {
    const { wrapper, calls, library } = await mountEntries();
    await rowButton(wrapper, "tidy", "Remove").trigger("click");
    await flushPromises();
    expect(calls).toEqual([["planRemove", { name: "tidy", catalog: "personal", type: "skill", dryRun: true, signal: undefined }], ["apply", "remove"]]);
    expect(wrapper.find(".remove__question").text()).toBe("Remove tidy from personal?");
    expect(wrapper.find(".remove__dependents").text().replace(/\s+/g, " ")).toBe("1 entry in personal still requires this one and will no longer resolve: skill:deploy.");
    expect(wrapper.find(".remove__diff").text()).toContain("-  - name: tidy");
    expect(wrapper.find(".remove__purge").exists()).toBe(false);

    library.state.entries = library.state.entries.filter((e) => e.name !== "tidy");
    await press(wrapper, "Remove the entry");
    expect(calls.slice(2)).toEqual([["planRemove", { name: "tidy", catalog: "personal", type: "skill", purge: false, signal: undefined }], ["apply", "remove"]]);
    expect(wrapper.find("#entry-tidy").exists()).toBe(false);
    expect(wrapper.find(".status-banner--success").text()).toBe("Removed tidy from personal, out of skills.");
  });

  it("offers to delete the installed copy only when it is this entry's", async () => {
    const mine = await mountEntries({}, [installedRecord("installed", { name: "tidy" })]);
    await rowButton(mine.wrapper, "tidy", "Remove").trigger("click");
    await flushPromises();
    await mine.wrapper.find(".remove__purge input").setValue(true);
    await press(mine.wrapper, "Remove and delete the copy");
    expect(mine.calls.at(-2)).toEqual(["planRemove", { name: "tidy", catalog: "personal", type: "skill", purge: true, signal: undefined }]);

    const theirs = await mountEntries({}, [entryRecord({ name: "tidy", overriddenBy: "team" }), installedRecord("installed", { name: "tidy", catalog: "team", overrides: ["personal"] })]);
    await rowButton(theirs.wrapper, "tidy", "Remove").trigger("click");
    await flushPromises();
    expect(theirs.wrapper.find(".remove__purge").exists()).toBe(false);
    expect(theirs.wrapper.find(".remove__orphan").text().replace(/\s+/g, " ")).toBe("The copy installed under this name came from team, so removing personal's entry leaves it in place.");
  });
});
