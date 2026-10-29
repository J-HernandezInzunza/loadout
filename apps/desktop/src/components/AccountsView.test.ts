import type { AccountHost, AccountInfo, Library, Result } from "@loadout/core";
import { accountInfo, seededState } from "@loadout/core/testing";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App.vue";
import { mountView } from "../testing/mountView.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value, warnings: [] });
const refused = (code: string, message: string) => ({ ok: false as const, error: { code, message }, warnings: [] }) as never;
const github = { on: "github", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: "2026-10-29T12:15:00Z" };
const bitbucket = { on: "bitbucket", authorizeUrl: "https://bitbucket.org/site/oauth2/authorize?client_id=k&state=s" };
const redirectUrl = "loadout://oauth/bitbucket?code=c&state=s";

const ipc: [string, unknown][] = [];
beforeEach(() => {
  ipc.length = 0;
  mockWindows("main");
  mockIPC((cmd, payload) => void ipc.push([cmd, payload]), { shouldMockEvents: true });
});
afterEach(() => clearMocks());

/** The app with GitHub connected and Bitbucket not; sign-ins and disconnects change what accounts() answers. */
function mountApp(library: Partial<Library> = {}) {
  const connected: Partial<Record<AccountHost, AccountInfo>> = { github: accountInfo({ login: "octo", scopes: ["repo"], connectedAt: "2026-10-01T12:00:00Z" }) };
  const calls: unknown[][] = [];
  const signedIn = (on: AccountHost, login: string) => {
    const account = accountInfo({ login, scopes: on === "github" ? ["repo"] : [] });
    connected[on] = account;
    return ok(account);
  };
  const mounted = mountView(App, {
    seed: { ...seededState(), accounts: connected },
    library: {
      beginSignIn: async (on) => (calls.push(["beginSignIn", on]), ok((on === "github" ? github : bitbucket) as never)),
      completeSignIn: async (started, o) => (calls.push(["completeSignIn", started.on, o?.redirectUrl]), signedIn(started.on, started.on === "github" ? "octo2" : "jose")),
      checkAccount: async (on) => ok({ login: connected[on]!.login, scopes: connected[on]!.scopes }),
      disconnect: async (on) => (delete connected[on], ok(undefined)),
      ...library,
    },
  });
  return { ...mounted, calls, connected };
}

type Wrapper = ReturnType<typeof mountApp>["wrapper"];
const press = async (w: Wrapper, label: string, within = "") => {
  const button = w.findAll(`${within} button`).find((b) => b.text() === label);
  if (!button) throw new Error(`no button '${label}' in ${within || "the app"}: ${w.findAll(`${within} button`).map((b) => b.text()).join(" | ")}`);
  await button.trigger("click");
  await flushPromises();
};
const host = (w: Wrapper, on: AccountHost) => w.find(`[aria-labelledby=accounts-${on}]`);
const say = (w: Wrapper, on: AccountHost) => host(w, on).text().replace(/\s+/g, " ");
const outcome = (w: Wrapper, on: AccountHost) => host(w, on).find(".accounts__outcome").text();
const opened = () => ipc.filter(([cmd]) => cmd === "plugin:opener|open_url").map(([, p]) => (p as { url: string }).url);

async function openAccounts(library: Partial<Library> = {}) {
  const mounted = mountApp(library);
  await flushPromises();
  await mounted.wrapper.find(".sidebar__accounts .sidebar__item").trigger("click");
  await flushPromises();
  return mounted;
}

describe("accounts page", () => {
  it("opens from the sidebar's Accounts and shows each host's account, or that none is signed in", async () => {
    const { wrapper } = await openAccounts();
    expect(wrapper.find(".page-title__heading").text()).toBe("Accounts");
    expect(say(wrapper, "github")).toContain("Signed in as octo since 2026-10-01");
    expect(host(wrapper, "github").find(".accounts__scopes").text()).toBe("Access: repo");
    expect(say(wrapper, "bitbucket")).toContain("Not signed in.");
    await press(wrapper, "← Loadout");
    expect(wrapper.find(".accounts").exists()).toBe(false);
  });

  it("checks a token and says whom it answers for, or why it doesn't work", async () => {
    const { wrapper } = await openAccounts();
    await press(wrapper, "Check", "[aria-labelledby=accounts-github]");
    expect(outcome(wrapper, "github")).toBe("The token works: octo (repo).");

    const failing = await openAccounts({ checkAccount: async () => refused("AUTH_FAILED", "GitHub no longer accepts the token; sign in again") });
    await press(failing.wrapper, "Check", "[aria-labelledby=accounts-github]");
    expect(outcome(failing.wrapper, "github")).toBe("GitHub no longer accepts the token; sign in again");
  });

  it("disconnects, saying the token is gone, and offers sign-in again", async () => {
    const { wrapper } = await openAccounts();
    await press(wrapper, "Disconnect", "[aria-labelledby=accounts-github]");
    expect(say(wrapper, "github")).toContain("Not signed in.");
    expect(outcome(wrapper, "github")).toBe("Disconnected; the token is gone from the Keychain.");
  });
});

describe("GitHub sign-in", () => {
  it("shows the code, opens GitHub's page, and reports the account once approved (connected)", async () => {
    let finish = () => {};
    const { wrapper, connected } = await openAccounts({
      completeSignIn: () =>
        new Promise((resolve) => {
          finish = () => {
            const account = accountInfo({ login: "octo2", scopes: ["repo"] });
            connected.github = account;
            resolve(ok(account));
          };
        }),
    });
    await press(wrapper, "Disconnect");
    await press(wrapper, "Sign in to GitHub");
    expect(host(wrapper, "github").find(".sign-in__code").text()).toBe("WDJB-MJHT");
    expect(opened()).toEqual(["https://github.com/login/device"]);
    await press(wrapper, "Open GitHub again");
    expect(opened()).toEqual(["https://github.com/login/device", "https://github.com/login/device"]);

    finish();
    await flushPromises();
    expect(outcome(wrapper, "github")).toBe("Signed in to GitHub as octo2. You can close the browser tab.");
    expect(say(wrapper, "github")).toContain("Signed in as octo2");
  });

  it("reports a declined sign-in (denied) and offers it again", async () => {
    const { wrapper } = await openAccounts({ completeSignIn: async () => refused("SIGN_IN_DENIED", "The GitHub sign-in was declined") });
    await press(wrapper, "Disconnect");
    await press(wrapper, "Sign in to GitHub");
    expect(outcome(wrapper, "github")).toBe("The GitHub sign-in was declined");
    expect(wrapper.findAll("button").some((b) => b.text() === "Sign in to GitHub")).toBe(true);
  });

  it("offers a new code when the last one expired, and starts again with it (expired)", async () => {
    let attempt = 0;
    const { wrapper, calls } = await openAccounts({
      completeSignIn: async () => (attempt++ === 0 ? refused("SIGN_IN_EXPIRED", "The code WDJB-MJHT expired before it was entered; start the sign-in again") : ok(accountInfo({ login: "octo" }))),
    });
    await press(wrapper, "Disconnect");
    await press(wrapper, "Sign in to GitHub");
    expect(outcome(wrapper, "github")).toContain("expired before it was entered");
    await press(wrapper, "Get a new code");
    expect(calls.filter(([op]) => op === "beginSignIn")).toEqual([["beginSignIn", "github"], ["beginSignIn", "github"]]);
    expect(outcome(wrapper, "github")).toBe("Signed in to GitHub as octo. You can close the browser tab.");
  });

  it("Cancel stops waiting and leaves no outcome behind (cancelled)", async () => {
    let signal: AbortSignal | undefined;
    const { wrapper } = await openAccounts({
      completeSignIn: (_started, o) =>
        new Promise((resolve) => {
          signal = o?.signal;
          signal?.addEventListener("abort", () => resolve(refused("CANCELLED", "Sign-in was cancelled")));
        }),
    });
    await press(wrapper, "Disconnect");
    await press(wrapper, "Sign in to GitHub");
    await press(wrapper, "Cancel", "[aria-labelledby=accounts-github]");
    expect(signal?.aborted).toBe(true);
    expect(say(wrapper, "github")).toBe("GitHub Not signed in. Sign in to GitHub");
  });

  it("says when this build can't sign in to a host, and offers no button that would fail again (unavailable)", async () => {
    const { wrapper } = await openAccounts({ beginSignIn: async () => refused("SIGN_IN_UNAVAILABLE", "This build has no Bitbucket OAuth consumer, so Bitbucket sign-in is unavailable") });
    await press(wrapper, "Sign in to Bitbucket");
    expect(host(wrapper, "bitbucket").find(".status-banner--warning, .accounts__outcome").text()).toContain("Bitbucket sign-in is unavailable");
    expect(host(wrapper, "bitbucket").find("button").attributes("disabled")).toBeDefined();
    expect(opened()).toEqual([]);
  });
});

describe("Bitbucket sign-in", () => {
  it("opens the consent page, and on the loadout:// redirect from any view comes forward to the accounts page with the account", async () => {
    const { wrapper, calls } = await openAccounts();
    await press(wrapper, "Sign in to Bitbucket");
    expect(opened()).toEqual([bitbucket.authorizeUrl]);
    expect(say(wrapper, "bitbucket")).toContain("Approve Loadout on Bitbucket's page in your browser");
    await press(wrapper, "← Loadout");

    await emit("deep-link://new-url", [redirectUrl]);
    await flushPromises();
    expect(ipc.some(([cmd]) => cmd === "plugin:window|set_focus")).toBe(true);
    expect(calls).toContainEqual(["completeSignIn", "bitbucket", redirectUrl]);
    expect(wrapper.find(".page-title__heading").text()).toBe("Accounts");
    expect(outcome(wrapper, "bitbucket")).toBe("Signed in to Bitbucket as jose. You can close the browser tab.");
    expect(say(wrapper, "bitbucket")).toContain("Signed in as jose");
  });

  it("refuses a redirect when no sign-in is in progress, including one cancelled", async () => {
    const { wrapper, calls } = await openAccounts();
    await press(wrapper, "Sign in to Bitbucket");
    await press(wrapper, "Cancel", "[aria-labelledby=accounts-bitbucket]");
    await emit("deep-link://new-url", [redirectUrl]);
    await flushPromises();
    expect(calls.filter(([op]) => op === "completeSignIn")).toEqual([]);
    expect(outcome(wrapper, "bitbucket")).toBe("A Bitbucket sign-in came back, but none is in progress here; start it again.");
  });

  it("reports a declined consent (denied)", async () => {
    const { wrapper } = await openAccounts({ completeSignIn: async () => refused("SIGN_IN_DENIED", "The Bitbucket sign-in was declined") });
    await press(wrapper, "Sign in to Bitbucket");
    await emit("deep-link://new-url", ["loadout://oauth/bitbucket?error=access_denied&state=s"]);
    await flushPromises();
    expect(outcome(wrapper, "bitbucket")).toBe("The Bitbucket sign-in was declined");
    expect(say(wrapper, "bitbucket")).toContain("Not signed in.");
  });

  it("ignores links that aren't Bitbucket's sign-in", async () => {
    const { wrapper } = await openAccounts();
    await press(wrapper, "← Loadout");
    await emit("deep-link://new-url", ["loadout://something-else"]);
    await flushPromises();
    expect(ipc.some(([cmd]) => cmd === "plugin:window|set_focus")).toBe(false);
    expect(wrapper.find(".accounts").exists()).toBe(false);
  });
});
