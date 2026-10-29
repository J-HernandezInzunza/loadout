import type { Library } from "@loadout/core";
import { catalogRow, entryRecord, pinRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import AddEntry from "./AddEntry.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const catalogs = [catalogRow({ id: "personal" }), catalogRow({ id: "team", precedence: 2, kind: "remote", writeMode: "pr" }), catalogRow({ id: "extra", precedence: 3 })];
const entries = [entryRecord({ name: "lint" }), entryRecord({ type: "prompt", name: "style" }), entryRecord({ name: "shared", catalog: "team" }), entryRecord({ name: "low", catalog: "extra" }), entryRecord({ name: "top", catalog: "team" })];
const ipc: [string, unknown][] = [];

beforeEach(() => {
  ipc.length = 0;
  mockIPC((cmd, payload) => {
    ipc.push([cmd, payload]);
    return cmd === "plugin:dialog|open" ? "/Users/dev/repo/skills/new/SKILL.md" : null;
  });
});
afterEach(() => clearMocks());

async function mountAdd(extra: Partial<Library> = {}, catalogId = "personal") {
  const calls: unknown[][] = [];
  const mounted = mountView(AddEntry, {
    seed: { catalogs, entries, pins: [] },
    props: { catalogId },
    library: {
      planAdd: async (req) => (calls.push(["planAdd", { ...req, signal: undefined }]), ok({ op: "add" } as never)),
      applyCatalogEdit: async () => (calls.push(["apply"]), ok({ op: "add" as const, added: [], mode: "local" as const, catalog: catalogId, changed: true, path: "/Users/dev/catalog/library.yaml", committed: false, pushed: false, branch: null })),
      suggestSource: async (path) => (calls.push(["suggest", path]), ok({ url: "https://github.com/acme/repo/blob/main/skills/new/SKILL.md", why: "" })),
      ...extra,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

type Wrapper = Awaited<ReturnType<typeof mountAdd>>["wrapper"];
const field = (w: Wrapper, placeholder: string) => w.find(`input[placeholder^="${placeholder}"]`);
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};

describe("UI-46: adding an entry", () => {
  it("adds through planAdd and the catalog's write, then says where it went and offers to show the file", async () => {
    const { wrapper, calls } = await mountAdd();
    expect(wrapper.find(".page-title__heading").text()).toBe("Add an entry to personal");
    expect(wrapper.find("[autofocus]").attributes("placeholder")).toBe("bug-investigator");
    expect((wrapper.find("select").element as HTMLSelectElement).value).toBe("skill");
    expect(wrapper.findAll(".add-entry__check > span:last-child").map((s) => s.text())).toEqual(["prompt:style", "skill:lint"]);

    await field(wrapper, "bug-investigator").setValue("tidy");
    await field(wrapper, "What it does").setValue(" Tidies things ");
    await field(wrapper, "https://github.com").setValue("https://github.com/acme/repo/blob/main/skills/tidy/SKILL.md");
    await wrapper.find(".add-entry__check input").setValue(true);
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const request: Parameters<Library["planAdd"]>[0] = {
      entries: [{ name: "tidy", type: "skill", description: "Tidies things", source: "https://github.com/acme/repo/blob/main/skills/tidy/SKILL.md", requires: ["prompt:style"] }],
      catalog: "personal",
    };
    expect(calls).toEqual([["planAdd", { ...request, signal: undefined }], ["apply"]]);
    expect(wrapper.find(".add-entry__added-line").text().replace(/\s+/g, " ")).toBe("Added tidy to personal, under skills.");
    await press(wrapper, "Show in Finder");
    expect(ipc).toContainEqual(["plugin:opener|reveal_item_in_dir", { paths: ["/Users/dev/catalog/library.yaml"] }]);
    expect((field(wrapper, "bug-investigator").element as HTMLInputElement).value).toBe("");
  });

  it("says live what the name would do: blocked here, winning over a lower catalog, or never installed under a higher one", async () => {
    const { wrapper } = await mountAdd({}, "extra");
    const name = field(wrapper, "bug-investigator");
    await name.setValue("low");
    expect(wrapper.find(".add-entry__conflict").text()).toContain("extra already has an entry called low");
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeDefined();
    await name.setValue("shared");
    expect(wrapper.find(".add-entry__consequence").text().replace(/\s+/g, " ")).toBe("shared also exists in team, which takes precedence. Your copy in extra would be added but never installed.");

    const top = await mountAdd();
    await field(top.wrapper, "bug-investigator").setValue("shared");
    expect(top.wrapper.find(".add-entry__consequence").text()).toContain("Your copy in personal takes precedence, so it becomes the one that installs.");
  });

  it("weighs a pin as the core does", async () => {
    const { wrapper } = await mountAdd({ pins: async () => ok([pinRecord({ name: "shared", catalog: "team", holders: ["team"], resolvesTo: "team" })]) });
    await field(wrapper, "bug-investigator").setValue("shared");
    expect(wrapper.find(".add-entry__consequence").text()).toContain("would be added but never installed");
  });

  it("suggests the shareable URL for a picked file, and uses it or keeps the path", async () => {
    const { wrapper, calls } = await mountAdd();
    await press(wrapper, "Choose file…");
    expect(calls).toContainEqual(["suggest", "/Users/dev/repo/skills/new/SKILL.md"]);
    expect(wrapper.find(".add-entry__suggestion code").text()).toBe("https://github.com/acme/repo/blob/main/skills/new/SKILL.md");
    await press(wrapper, "Use this URL");
    expect((field(wrapper, "https://github.com").element as HTMLInputElement).value).toBe("https://github.com/acme/repo/blob/main/skills/new/SKILL.md");
  });

  it("says why a typed path has no shareable URL", async () => {
    const { wrapper } = await mountAdd({ suggestSource: async () => ok({ url: null, why: "not inside a git repository" }) });
    const source = field(wrapper, "https://github.com");
    await source.setValue("~/notes/thing.md");
    await source.trigger("change");
    await flushPromises();
    expect(wrapper.find(".add-entry__hint:last-of-type").text()).toContain("No shareable URL for this file: not inside a git repository.");
  });

  it("shows the core's refusal, such as a source inside an install directory, and Back returns to the catalog", async () => {
    const { wrapper } = await mountAdd({
      planAdd: async () => ({ ok: false, error: { code: "SOURCE_IN_INSTALL_DIR", message: "~/.claude/skills/x is where Loadout installs skills; an entry sourced there is overwritten by its own install" }, warnings: [] }),
    });
    await field(wrapper, "bug-investigator").setValue("x");
    await field(wrapper, "What it does").setValue("x");
    await field(wrapper, "https://github.com").setValue("~/.claude/skills/x/SKILL.md");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".status-banner--error pre").text()).toContain("is where Loadout installs skills");
    useViewStore().addingTo = "personal";
    await wrapper.find(".view__head button").trigger("click");
    expect(useViewStore().addingTo).toBeNull();
  });
});
