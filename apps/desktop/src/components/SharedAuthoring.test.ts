import type { AccountHost, AccountInfo, CatalogRow, Library, Result, Warning } from "@loadout/core";
import { accountInfo, catalogRow, entryRecord } from "@loadout/core/testing";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { enableAutoUnmount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import AddEntry from "./AddEntry.vue";
import CatalogsView from "./CatalogsView.vue";

const ok = <T>(value: T, warnings: Warning[] = []): Result<T> => ({ ok: true, value, warnings });
const location = "git@bitbucket.org:acme/catalog.git (main, library.yaml)";
const pr = catalogRow({ id: "team", precedence: 2, kind: "remote", writeMode: "pr", accountHost: "bitbucket", location });
const direct = catalogRow({ id: "team", precedence: 2, kind: "remote", writeMode: "direct", accountHost: "bitbucket", location });
const compareUrl = "https://bitbucket.org/acme/catalog/branch/library/add-tidy-20261029T120000?dest=main";
const prResult = { mode: "pr" as const, catalog: "team", changed: true, branch: "library/add-tidy-20261029T120000" };
const directResult = { mode: "direct" as const, catalog: "team", changed: true, path: "/app/clones/team/library.yaml", committed: true, pushed: true, branch: "main" };
const added = { op: "add" as const, added: [{ type: "skill" as const, name: "tidy" }] };

const ipc: [string, unknown][] = [];
beforeEach(() => {
  ipc.length = 0;
  mockWindows("main");
  mockIPC((cmd, payload) => void ipc.push([cmd, payload]), { shouldMockEvents: true });
});
afterEach(() => clearMocks());
// Mounted into the document for the focus checks, so each is taken out again.
enableAutoUnmount(afterEach);
const opened = () => ipc.filter(([cmd]) => cmd === "plugin:opener|open_url").map(([, p]) => (p as { url: string }).url);

/** AddEntry on `team`, with the accounts the test says are connected; every op it reaches is recorded. */
async function mountAdd(row: CatalogRow, library: Partial<Library> = {}, accounts: Partial<Record<AccountHost, AccountInfo>> = {}) {
  const calls: unknown[][] = [];
  const mounted = mountView(AddEntry, {
    seed: { catalogs: [catalogRow(), row], entries: [entryRecord({ name: "lint" })], pins: [], accounts },
    props: { catalogId: "team" },
    attachTo: document.body,
    library: {
      planAdd: async () => (calls.push(["planAdd"]), ok({ op: "add" } as never)),
      applyCatalogEdit: async () => (calls.push(["apply"]), ok({ ...prResult, method: "api" as const, prUrl: "https://bitbucket.org/acme/catalog/pull-requests/7", ...added })),
      discardCatalogEdit: async () => (calls.push(["discard"]), ok(undefined)),
      ...library,
    },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, calls };
}

/** either page: the helpers only look things up */
type Wrapper = Pick<VueWrapper, "find" | "findAll">;
const press = async (w: Wrapper, label: string) => {
  const button = w.findAll("button").find((b) => b.text() === label);
  if (!button) throw new Error(`no button '${label}': ${w.findAll("button").map((b) => b.text()).join(" | ")}`);
  await button.trigger("click");
  await flushPromises();
};
const text = (w: Wrapper, selector: string) => w.find(selector).text().replace(/\s+/g, " ");

async function submitTidy(wrapper: Wrapper) {
  await wrapper.find('input[placeholder^="bug-investigator"]').setValue("tidy");
  await wrapper.find('input[placeholder^="What it does"]').setValue("Tidies");
  await wrapper.find('input[placeholder^="https://github.com"]').setValue("https://github.com/acme/repo/blob/main/skills/tidy/SKILL.md");
  await wrapper.find("form").trigger("submit");
  await flushPromises();
}

describe("writing to a shared catalog through a pull request", () => {
  it("with the host's account connected, opens the PR straight away and links to it (API)", async () => {
    const { wrapper, calls } = await mountAdd(pr, {}, { bitbucket: accountInfo({ login: "jose" }) });
    await submitTidy(wrapper);
    expect(calls).toEqual([["planAdd"], ["apply"]]);
    expect(wrapper.find(".write-gate").exists()).toBe(false);
    expect(text(wrapper, ".landing__line")).toBe("Pull request opened from library/add-tidy-20261029T120000.");
    await press(wrapper, "View the pull request");
    expect(opened()).toEqual(["https://bitbucket.org/acme/catalog/pull-requests/7"]);
    // A remote's file is Loadout's clone, not the user's to open.
    expect(wrapper.findAll("button").some((b) => b.text() === "Show in Finder")).toBe(false);
  });

  it("with no account, offers to connect or to continue and get a link, which pushes the branch and links its compare page (manual)", async () => {
    const { wrapper, calls } = await mountAdd(pr, {
      applyCatalogEdit: async () => (calls.push(["apply"]), ok({ ...prResult, method: "manual" as const, compareUrl, ...added })),
    });
    await submitTidy(wrapper);
    expect(calls).toEqual([["planAdd"]]);
    expect(text(wrapper, ".write-gate__question")).toBe("Connect Bitbucket to open the pull request here, or continue and get a link to open it yourself.");
    expect(document.activeElement?.textContent?.trim()).toBe("Connect Bitbucket");

    await press(wrapper, "Continue and get a link");
    expect(calls).toEqual([["planAdd"], ["apply"]]);
    expect(text(wrapper, ".landing__line")).toBe(
      "Branch library/add-tidy-20261029T120000 pushed — the pull request is not open yet, and nobody has been asked to review anything until you open it.",
    );
    await press(wrapper, "Open a pull request");
    expect(opened()).toEqual([compareUrl]);
  });

  it("connects the account in place (the redirect doesn't leave the form), then opens the PR here", async () => {
    const started = { on: "bitbucket", authorizeUrl: "https://bitbucket.org/site/oauth2/authorize?state=s" };
    const accounts: Partial<Record<AccountHost, AccountInfo>> = {};
    const { wrapper, calls } = await mountAdd(
      pr,
      {
        beginSignIn: async () => ok(started as never),
        completeSignIn: async (_s, o) => {
          calls.push(["completeSignIn", o?.redirectUrl]);
          const account = accountInfo({ login: "jose" });
          accounts.bitbucket = account;
          return ok(account);
        },
      },
      accounts,
    );
    await submitTidy(wrapper);
    await press(wrapper, "Connect Bitbucket");
    expect(opened()).toEqual([started.authorizeUrl]);
    expect(wrapper.find(".write-gate").text()).toContain("Approve Loadout on Bitbucket's page in your browser");

    await emit("deep-link://new-url", ["loadout://oauth/bitbucket?code=c&state=s"]);
    await flushPromises();
    expect(useViewStore().accounts).toBe(false);
    expect(text(wrapper, ".write-gate__question")).toBe("Signed in to Bitbucket as jose, so the pull request opens from here.");
    await press(wrapper, "Open the pull request");
    expect(calls).toEqual([["planAdd"], ["completeSignIn", "loadout://oauth/bitbucket?code=c&state=s"], ["apply"]]);
    expect(text(wrapper, ".landing__line")).toBe("Pull request opened from library/add-tidy-20261029T120000.");
  });

  it("shows a failed sign-in in place and still offers the link", async () => {
    const { wrapper } = await mountAdd(pr, { beginSignIn: async () => ({ ok: false, error: { code: "SIGN_IN_UNAVAILABLE", message: "This build has no Bitbucket OAuth consumer, so Bitbucket sign-in is unavailable" }, warnings: [] }) });
    await submitTidy(wrapper);
    await press(wrapper, "Connect Bitbucket");
    expect(wrapper.find(".write-gate").text()).toContain("Bitbucket sign-in is unavailable");
    expect(wrapper.findAll(".write-gate button").map((b) => b.text())).toContain("Continue and get a link");
  });
});

describe("writing to a shared catalog that takes direct pushes", () => {
  it("asks before pushing, then commits and pushes on yes (confirm)", async () => {
    const { wrapper, calls } = await mountAdd(direct, { applyCatalogEdit: async () => (calls.push(["apply"]), ok({ ...directResult, ...added })) });
    await submitTidy(wrapper);
    expect(calls).toEqual([["planAdd"]]);
    expect(text(wrapper, ".write-gate__question")).toBe(`team takes changes straight to its repository: this is committed and pushed to ${location}, with no pull request and no review.`);
    expect(document.activeElement?.textContent?.trim()).toBe("Push it");
    await press(wrapper, "Push it");
    expect(calls).toEqual([["planAdd"], ["apply"]]);
    expect(text(wrapper, ".add-entry__added-line")).toBe("Added tidy to team, under skills.");
    expect(text(wrapper, ".landing__line")).toBe("Committed and pushed to team's main.");
  });

  it("writes nothing on no, drops the plan, and keeps the form (refusal)", async () => {
    const { wrapper, calls } = await mountAdd(direct);
    await submitTidy(wrapper);
    await press(wrapper, "Don't push");
    expect(calls).toEqual([["planAdd"], ["discard"]]);
    expect(wrapper.find(".write-gate").exists()).toBe(false);
    expect(wrapper.find(".add-entry__added-line").exists()).toBe(false);
    expect((wrapper.find('input[placeholder^="bug-investigator"]').element as HTMLInputElement).value).toBe("tidy");
  });

  it("says when the commit landed in the clone but the push didn't, with git's reason", async () => {
    const { wrapper } = await mountAdd(direct, {
      applyCatalogEdit: async () => ok({ ...directResult, pushed: false, ...added }, [{ message: "push to main failed: rejected (fetch first)" }]),
    });
    await submitTidy(wrapper);
    await press(wrapper, "Push it");
    expect(text(wrapper, ".landing__line")).toBe("Saved in team's clone, but not pushed. Doctor can re-clone it if the push keeps failing.");
    expect(text(wrapper, ".landing__detail")).toBe("push to main failed: rejected (fetch first)");
  });

  it("drops the plan when the page closes with the question open", async () => {
    const { wrapper, calls } = await mountAdd(direct);
    await submitTidy(wrapper);
    wrapper.unmount();
    await flushPromises();
    expect(calls).toEqual([["planAdd"], ["discard"]]);
  });
});

describe("a plan gone stale", () => {
  it("is planned again and shown again before anything is written", async () => {
    let applies = 0;
    const { wrapper, calls } = await mountAdd(pr, {
      applyCatalogEdit: async () => {
        calls.push(["apply"]);
        if (applies++ === 0) return { ok: false, error: { code: "STALE_PLAN", message: "the catalog changed after the plan" }, warnings: [] };
        return ok({ ...prResult, method: "api" as const, prUrl: "https://bitbucket.org/acme/catalog/pull-requests/8", ...added });
      },
    }, { bitbucket: accountInfo({ login: "jose" }) });
    await submitTidy(wrapper);
    expect(calls).toEqual([["planAdd"], ["apply"], ["discard"], ["planAdd"]]);
    expect(text(wrapper, ".write-gate__replanned")).toBe("team changed after this was planned, so it was planned again against what is there now.");
    await press(wrapper, "Go on");
    expect(calls.at(-1)).toEqual(["apply"]);
    expect(text(wrapper, ".landing__line")).toBe("Pull request opened from library/add-tidy-20261029T120000.");
  });
});

describe("editing and removing in a shared catalog", () => {
  const entries = [entryRecord({ name: "tidy", catalog: "team", description: "Tidies", source: "https://x/SKILL.md" })];
  const write = { ...directResult };

  async function mountTeam(library: Partial<Library> = {}) {
    const calls: unknown[][] = [];
    const mounted = mountView(CatalogsView, {
      seed: { catalogs: [catalogRow(), direct], entries },
      props: { at: "team", back: "Loadout" },
      library: {
        planUpdate: async () => (calls.push(["planUpdate"]), ok({ op: "update" } as never)),
        planRemove: async (req) => (calls.push(["planRemove", req.dryRun ?? false]), ok({ op: "remove", dependents: [] } as never)),
        applyCatalogEdit: async (plan) => {
          calls.push(["apply", plan.op]);
          if (plan.op === "update") return ok({ ...write, op: "update" as const, name: "tidy" });
          return ok({ ...write, op: "remove" as const, removed: { type: "skill" as const, name: "tidy" }, dependents: [], deleted: [], diff: "-  - name: tidy" });
        },
        discardCatalogEdit: async () => (calls.push(["discard"]), ok(undefined)),
        ...library,
      },
    });
    await useCatalogStore().reload();
    await flushPromises();
    return { ...mounted, calls };
  }
  const rowButton = (w: Wrapper, label: string) => w.find("#entry-tidy").findAll("button").find((b) => b.text() === label)!;

  it("an edit asks before pushing, and says it was pushed", async () => {
    const { wrapper, calls } = await mountTeam();
    await rowButton(wrapper, "Edit").trigger("click");
    await wrapper.find(".editor input").setValue("Tidies more");
    await wrapper.find(".editor form").trigger("submit");
    await flushPromises();
    expect(calls).toEqual([["planUpdate"]]);
    await press(wrapper, "Push it");
    expect(calls).toEqual([["planUpdate"], ["apply", "update"]]);
    expect(text(wrapper, ".landing__line")).toBe("Committed and pushed to team's main.");
  });

  it("a removal previews without asking, asks before pushing, and says it was pushed on the catalog page", async () => {
    const { wrapper, calls } = await mountTeam();
    await rowButton(wrapper, "Remove").trigger("click");
    await flushPromises();
    expect(calls).toEqual([["planRemove", true], ["apply", "remove"]]);
    await press(wrapper, "Remove the entry");
    expect(wrapper.find(".write-gate").exists()).toBe(true);
    await press(wrapper, "Push it");
    expect(calls.slice(2)).toEqual([["planRemove", false], ["apply", "remove"]]);
    expect(wrapper.find(".landing__line").text()).toBe("Committed and pushed to team's main.");
  });
});
