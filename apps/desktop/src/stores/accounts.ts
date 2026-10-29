import type { AccountHost, AccountInfo, CoreError, IssuedSignIn } from "@loadout/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defineStore } from "pinia";
import { ref } from "vue";
import { useLibrary } from "../services.ts";
import { useViewStore } from "./views.ts";

export const HOST_NAMES: Record<AccountHost, string> = { github: "GitHub", bitbucket: "Bitbucket" };

/** How the last thing done to a host's account went, worded for the page. */
export interface AccountOutcome {
  kind: "success" | "error" | "warning";
  message: string;
  /** the core's reason, when it failed: the page offers a restart on an expired code */
  code?: CoreError["code"];
}

const BITBUCKET_REDIRECT = "loadout://oauth/bitbucket";

/**
 * The connected accounts and any sign-in waiting on the browser. A store rather than the page's own state
 * because Bitbucket answers through a loadout:// link, which can arrive whichever view is showing.
 */
export const useAccountStore = defineStore("accounts", () => {
  const library = useLibrary();
  const views = useViewStore();

  const accounts = ref<Partial<Record<AccountHost, AccountInfo>>>({});
  /** a sign-in started and not yet finished: GitHub's code being entered, or Bitbucket's consent page open */
  const pending = ref<Partial<Record<AccountHost, IssuedSignIn>>>({});
  const outcomes = ref<Partial<Record<AccountHost, AccountOutcome>>>({});
  let githubPoll: AbortController | null = null;

  const failed = (on: AccountHost, error: CoreError) => {
    const kind = error.code === "SIGN_IN_UNAVAILABLE" ? "warning" : "error";
    outcomes.value[on] = { kind, message: error.message, code: error.code };
  };

  async function load() {
    const listed = await library.accounts();
    if (listed.ok) accounts.value = listed.value;
  }

  async function signedIn(on: AccountHost, account: AccountInfo) {
    outcomes.value[on] = { kind: "success", message: `Signed in to ${HOST_NAMES[on]} as ${account.login}. You can close the browser tab.` };
    await load();
  }

  async function signIn(on: AccountHost) {
    delete outcomes.value[on];
    const started = await library.beginSignIn(on);
    if (!started.ok) return failed(on, started.error);
    pending.value[on] = started.value;
    if (started.value.on === "bitbucket") {
      // The rest arrives as a redirect (onRedirect).
      await openUrl(started.value.authorizeUrl);
      return;
    }
    githubPoll = new AbortController();
    await openUrl(started.value.verificationUri);
    const done = await library.completeSignIn(started.value, { signal: githubPoll.signal });
    delete pending.value.github;
    githubPoll = null;
    if (done.ok) await signedIn(on, done.value);
    else if (done.error.code !== "CANCELLED") failed(on, done.error);
  }

  /** GitHub stops polling; Bitbucket forgets the sign-in, so a late redirect for it is refused. */
  function cancel(on: AccountHost) {
    if (on === "github") githubPoll?.abort();
    else delete pending.value.bitbucket;
  }

  async function onRedirect(urls: string[]) {
    const redirectUrl = urls.find((url) => url.startsWith(BITBUCKET_REDIRECT));
    if (redirectUrl === undefined) return;
    // The browser tab stays on Bitbucket's page, so Loadout comes forward to say how it went.
    await getCurrentWindow().setFocus();
    views.accounts = true;
    const started = pending.value.bitbucket;
    delete pending.value.bitbucket;
    if (started === undefined) {
      outcomes.value.bitbucket = { kind: "error", message: "A Bitbucket sign-in came back, but none is in progress here; start it again." };
      return;
    }
    const done = await library.completeSignIn(started, { redirectUrl });
    if (done.ok) await signedIn("bitbucket", done.value);
    else failed("bitbucket", done.error);
  }

  async function check(on: AccountHost) {
    delete outcomes.value[on];
    const checked = await library.checkAccount(on);
    if (!checked.ok) return failed(on, checked.error);
    const scopes = checked.value.scopes?.join(", ") || "no scopes reported";
    outcomes.value[on] = { kind: "success", message: `The token works: ${checked.value.login} (${scopes}).` };
  }

  async function disconnect(on: AccountHost) {
    delete outcomes.value[on];
    const done = await library.disconnect(on);
    if (!done.ok) return failed(on, done.error);
    outcomes.value[on] = { kind: "success", message: "Disconnected; the token is gone from the Keychain." };
    await load();
  }

  // Outside Tauri there is no deep-link plugin to listen to.
  onOpenUrl((urls) => void onRedirect(urls)).catch(() => {});

  return { accounts, pending, outcomes, load, signIn, cancel, check, disconnect };
});
