import type { AccountHost, AccountInfo, HostedRepo, Library, Result } from "@loadout/core";
import { accountInfo, catalogRow } from "@loadout/core/testing";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountView } from "../testing/mountView.ts";
import RegisterCatalog from "./RegisterCatalog.vue";

const ok = <T>(value: T): Result<T> => ({ ok: true, value, warnings: [] });
const refused = (code: string, message: string) => ({ ok: false as const, error: { code, message }, warnings: [] }) as never;
const repo = (org: string, name: string, on: AccountHost = "github", isPrivate = false): HostedRepo => ({
  org,
  name,
  private: isPrivate,
  repo: `https://${on === "github" ? "github.com" : "bitbucket.org"}/${org}/${name}.git`,
});
const githubRepos = [repo("acme", "agentics", "github", true), repo("acme", "website"), repo("octo", "dotfiles")];

const ipc: [string, unknown][] = [];
beforeEach(() => {
  ipc.length = 0;
  mockWindows("main");
  mockIPC((cmd, payload) => void ipc.push([cmd, payload]), { shouldMockEvents: true });
});
afterEach(() => clearMocks());

/**
 * RegisterCatalog in shared mode over a fake whose repositories hold a catalog only in acme/agentics (main)
 * and, on its dev branch, at catalog/library.yaml.
 */
function mountShared(library: Partial<Library> = {}, accounts: Partial<Record<AccountHost, AccountInfo>> = { github: accountInfo({ login: "octo" }) }) {
  const calls: unknown[][] = [];
  const mounted = mountView(RegisterCatalog, {
    seed: { accounts },
    props: { catalogs: [catalogRow()], start: "remote" },
    library: {
      listRepos: async (on) => (calls.push(["listRepos", on]), ok(on === "github" ? githubRepos : [repo("myworkspace", "agent-library", "bitbucket")])),
      checkCatalogRepo: async (req) => {
        calls.push(["checkCatalogRepo", { ...req, signal: undefined }]);
        if (req.org === "acme" && req.name === "hidden") return refused("NOT_FOUND", "GitHub shows no acme/hidden to this account: it doesn't exist, or the account can't read it");
        const branch = req.branch ?? "main";
        const yamlPath = req.yamlPath ?? "library.yaml";
        const found = req.name !== "website" && (branch === "main" ? yamlPath === "library.yaml" : yamlPath === "catalog/library.yaml");
        return ok({ defaultBranch: "main", branch, yamlPath, found });
      },
      planAddCatalog: async (req) => (calls.push(["planAddCatalog", { ...req, signal: undefined }]), ok({ ref: { id: req.id }, position: "first", file: "/x/library.yaml", entries: 3 } as never)),
      applyAddCatalog: async () => ok([{ id: "agentics", kind: "local" as const, path: "/x" }]),
      ...library,
    },
  });
  return { ...mounted, calls };
}

type Wrapper = Pick<VueWrapper, "find" | "findAll">;
const choose = async (w: Wrapper, value: string) => {
  await w.find(`input[value="${value}"]`).setValue(true);
  await flushPromises();
};
const options = (w: Wrapper) => w.findAll(".repo-picker__option").map((o) => o.findAll("span").map((t) => t.text()).join(" "));
const submit = (w: Wrapper) => w.find("button[type=submit]");

describe("picking a shared catalog from a connected account", () => {
  it("lists every repository the account can read, filters them, and checks the picked one before anything is cloned", async () => {
    const { wrapper, calls } = mountShared();
    await choose(wrapper, "github");
    expect(wrapper.find(".repo-picker__hint").text()).toBe("Signed in to GitHub as octo: listing every repository it can read, yours or not.");
    expect(options(wrapper)).toEqual(["acme/agentics private", "acme/website", "octo/dotfiles", "Other: paste a link"]);
    await wrapper.find(".repo-picker__filter").setValue("ACME/");
    expect(options(wrapper)).toEqual(["acme/agentics private", "acme/website", "Other: paste a link"]);

    await choose(wrapper, "https://github.com/acme/agentics.git");
    expect(calls).toEqual([["listRepos", "github"], ["checkCatalogRepo", { on: "github", org: "acme", name: "agentics", signal: undefined }]]);
    expect(wrapper.find(".repo-picker__found").text()).toBe("Found library.yaml on main.");
    expect((wrapper.find("input[type=text]").element as HTMLInputElement).value).toBe("agentics");

    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(calls.at(-1)).toEqual([
      "planAddCatalog",
      { kind: "remote", id: "agentics", repo: "https://github.com/acme/agentics.git", branch: "main", protected: true, position: "first", signal: undefined },
    ]);
  });

  it("refuses a repository without library.yaml", async () => {
    const { wrapper } = mountShared();
    await choose(wrapper, "github");
    await choose(wrapper, "https://github.com/acme/website.git");
    expect(wrapper.find(".repo-picker__found").text()).toBe("There is no library.yaml on main, so this isn't a catalog Loadout can read.");
    expect(submit(wrapper).attributes("disabled")).toBeDefined();
  });

  it("takes a pasted link under Other, branch and file path included, and says what can't be read", async () => {
    const { wrapper, calls } = mountShared();
    await choose(wrapper, "github");
    await choose(wrapper, "other");
    const link = wrapper.find(".repo-picker__field input");
    await link.setValue("https://github.com/acme/hidden");
    await flushPromises();
    expect(wrapper.find(".repo-picker").text()).toContain("GitHub shows no acme/hidden to this account");
    await link.setValue("https://bitbucket.org/myworkspace/agent-library");
    await flushPromises();
    expect(wrapper.find(".repo-picker__problem").text()).toBe("That isn't a GitHub repository; choose where it lives above.");
    expect(submit(wrapper).attributes("disabled")).toBeDefined();

    await link.setValue("https://github.com/acme/agentics/blob/dev/catalog/library.yaml");
    await flushPromises();
    expect(calls.at(-1)).toEqual(["checkCatalogRepo", { on: "github", org: "acme", name: "agentics", branch: "dev", yamlPath: "catalog/library.yaml", signal: undefined }]);
    expect(wrapper.find(".repo-picker__found").text()).toBe("Found catalog/library.yaml on dev.");
    await wrapper.find("input[type=text]").setValue("team");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(calls.at(-1)).toEqual(["planAddCatalog", expect.objectContaining({ repo: "https://github.com/acme/agentics.git", branch: "dev", yamlPath: "catalog/library.yaml" })]);
  });

  it("checks again when another branch is typed in", async () => {
    const { wrapper, calls } = mountShared();
    await choose(wrapper, "github");
    await choose(wrapper, "https://github.com/acme/agentics.git");
    const branch = wrapper.findAll(".repo-picker__field input").at(-1)!;
    await branch.setValue("dev");
    await branch.trigger("change");
    await flushPromises();
    expect(calls.at(-1)).toEqual(["checkCatalogRepo", { on: "github", org: "acme", name: "agentics", branch: "dev", signal: undefined }]);
    expect(wrapper.find(".repo-picker__found").text()).toBe("There is no library.yaml on dev, so this isn't a catalog Loadout can read.");
  });

  it("without an account, connects it in place and then lists (Bitbucket)", async () => {
    const accounts: Partial<Record<AccountHost, AccountInfo>> = {};
    const started = { on: "bitbucket", authorizeUrl: "https://bitbucket.org/site/oauth2/authorize?state=s" };
    const { wrapper, calls } = mountShared(
      {
        beginSignIn: async () => ok(started as never),
        completeSignIn: async () => {
          const account = accountInfo({ login: "jose" });
          accounts.bitbucket = account;
          return ok(account);
        },
      },
      accounts,
    );
    await choose(wrapper, "bitbucket");
    expect(wrapper.find(".repo-picker__line").text()).toContain("this machine needs no SSH key");
    expect(calls).toEqual([]);
    await wrapper.findAll("button").find((b) => b.text() === "Connect Bitbucket")!.trigger("click");
    await flushPromises();
    await emit("deep-link://new-url", ["loadout://oauth/bitbucket?code=c&state=s"]);
    await flushPromises();
    expect(calls).toEqual([["listRepos", "bitbucket"]]);
    expect(options(wrapper)).toEqual(["myworkspace/agent-library", "Other: paste a link"]);
  });

  it("a failed sign-in (here: unavailable) says why and leaves Somewhere else for a clone URL", async () => {
    const { wrapper } = mountShared({ beginSignIn: async () => refused("SIGN_IN_UNAVAILABLE", "This build has no GitHub client ID, so GitHub sign-in is unavailable") }, {});
    await choose(wrapper, "github");
    await wrapper.findAll("button").find((b) => b.text() === "Connect GitHub")!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".repo-picker").text()).toContain("GitHub sign-in is unavailable");
    expect(wrapper.find(".repo-picker").text()).toContain("Or choose Somewhere else above to paste a clone URL without connecting.");
    await choose(wrapper, "elsewhere");
    expect(wrapper.findAll("input[type=text]").length).toBe(3);
  });
});
