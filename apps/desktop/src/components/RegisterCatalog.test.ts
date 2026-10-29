import type { Library } from "@loadout/core";
import { catalogRow } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountView } from "../testing/mountView.ts";
import RegisterCatalog, { type RegisterMode } from "./RegisterCatalog.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const ref = (id: string) => ({ id, kind: "local" as const, path: `/p/${id}.yaml` });
const dialogs: unknown[] = [];
let picked = "/Users/dev/catalogs/work/library.yaml";

beforeEach(() => {
  dialogs.length = 0;
  mockIPC((cmd, payload) => {
    if (cmd === "plugin:dialog|open") {
      dialogs.push((payload as { options: unknown }).options);
      return picked;
    }
    return null;
  });
});
afterEach(() => clearMocks());

function mountRegister(start: RegisterMode, library: Partial<Library> = {}) {
  const calls: unknown[][] = [];
  const mounted = mountView(RegisterCatalog, {
    props: { catalogs: [catalogRow()], start },
    library: {
      planAddCatalog: async (req) => (calls.push(["planAddCatalog", { ...req, signal: undefined }]), ok({ ref: ref(req.id), position: req.position ?? "first", file: "/Users/dev/catalogs/work/library.yaml", entries: 4 } as never)),
      applyAddCatalog: async () => (calls.push(["applyAddCatalog"]), ok([ref("work"), ref("personal")])),
      initCatalog: async (req) => (calls.push(["initCatalog", req]), ok({ created: `${req.path}/library.yaml`, catalogs: [ref("personal"), ref("mine")] })),
      ...library,
    },
  });
  return { ...mounted, calls };
}

type Wrapper = ReturnType<typeof mountRegister>["wrapper"];
const press = async (w: Wrapper, label: string) => {
  await w.findAll("button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
};

describe("UI-44: registering a catalog", () => {
  it("registers an existing library.yaml, picked as a file, ahead of the others, and says where it now ranks", async () => {
    const { wrapper, calls } = mountRegister("existing");
    expect(wrapper.find(".register__hint:not(.register__mode-hint)").text()).toBe("The catalog's library.yaml.");
    await wrapper.find("input[type=text]").setValue("work");
    await press(wrapper, "Choose library.yaml…");
    expect(dialogs).toEqual([expect.objectContaining({ filters: [{ name: "Catalog", extensions: ["yaml", "yml"] }] })]);
    expect(dialogs[0]).not.toHaveProperty("directory", true);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(calls).toEqual([["planAddCatalog", { kind: "local", id: "work", path: picked, position: "first", signal: undefined }], ["applyAddCatalog"]]);
    const done = wrapper.find(".register__done").text().replace(/\s+/g, " ");
    expect(done).toBe("Registered work — 4 entries, checked first of 2 catalogs — its copies win if another catalog defines the same name.");
    expect(wrapper.find(".register__done-displaced").text()).toBe("This also moved personal down to precedence 2.");
  });

  it("blocks an id already registered", async () => {
    const { wrapper } = mountRegister("existing");
    await wrapper.find("input[type=text]").setValue("personal");
    expect(wrapper.find(".register__conflict").text()).toContain("is already registered");
    expect(wrapper.find("button[type=submit]").attributes("disabled")).toBeDefined();
  });

  it("creates a new one in a folder, prefilled 'personal' when free, and offers to register a file that's already there", async () => {
    picked = "/Users/dev/catalogs/mine";
    const fresh = mountRegister("create", { initCatalog: async () => ({ ok: false, error: { code: "DUPLICATE", message: "/Users/dev/catalogs/mine/library.yaml already exists; register it instead of creating it" }, warnings: [] }) });
    const id = fresh.wrapper.find("input[type=text]");
    expect((id.element as HTMLInputElement).value).toBe("");
    await id.setValue("mine");
    await press(fresh.wrapper, "Choose folder…");
    expect(dialogs).toEqual([expect.objectContaining({ directory: true })]);
    await fresh.wrapper.find("form").trigger("submit");
    await flushPromises();
    await press(fresh.wrapper, "Register the one that's there");
    expect(fresh.wrapper.find("input[value=existing]").element).toHaveProperty("checked", true);

    const prefilled = mountView(RegisterCatalog, { props: { catalogs: [catalogRow({ id: "team" })], start: "create" } });
    expect((prefilled.wrapper.find("input[type=text]").element as HTMLInputElement).value).toBe("personal");
  });

  it("adds a shared repository through pull requests by default; direct pushes need an explicit acknowledgement", async () => {
    const { wrapper, calls } = mountRegister("remote");
    await wrapper.find("input[value=elsewhere]").setValue(true);
    const [id, url, branch] = wrapper.findAll("input[type=text]");
    await id!.setValue("team2");
    await url!.setValue("git@bitbucket.org:acme/other.git");
    await branch!.setValue("trunk");
    const submit = wrapper.find("button[type=submit]");
    expect(submit.attributes("disabled")).toBeUndefined();

    await wrapper.findAll(".register__check input")[0]!.setValue(false);
    expect(submit.attributes("disabled")).toBeDefined();
    expect(wrapper.find(".register__check--warn").text()).toContain("push directly to trunk");
    await wrapper.find(".register__check--warn input").setValue(true);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(calls[0]).toEqual(["planAddCatalog", { kind: "remote", id: "team2", repo: "git@bitbucket.org:acme/other.git", branch: "trunk", protected: false, position: "first", signal: undefined }]);
  });

  it("reduces a pasted browser link to the repository, keeping the file path it points at", async () => {
    const { wrapper, calls } = mountRegister("remote");
    await wrapper.find("input[value=elsewhere]").setValue(true);
    const [id, url, branch] = wrapper.findAll("input[type=text]");
    await id!.setValue("team2");
    await url!.setValue("https://bitbucket.org/acme/other/src/main/catalog/library.yaml");
    await branch!.setValue("main");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(calls[0]).toEqual(["planAddCatalog", expect.objectContaining({ repo: "https://bitbucket.org/acme/other.git", branch: "main", yamlPath: "catalog/library.yaml" })]);
  });
});
