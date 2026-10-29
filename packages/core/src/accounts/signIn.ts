// Browser sign-in (architecture.md §5.5, spikes.md S12). GitHub uses the device flow: the user enters a
// short code at github.com, and Loadout polls until they decide; no client secret, no redirect.
// Bitbucket uses the authorization code flow: its consent page redirects to loadout://oauth/bitbucket
// (the consumer's registered callback), and the code is exchanged with the consumer's key and secret.
// Either way the sign-in ends in connect(), which validates and stores the token like any other.
import type { AccountInfo } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";
import type { Accounts } from "./accounts.ts";
import type { ApiBases } from "./apiBases.ts";

export interface SignInCtx {
  host: Host;
  apiBases: ApiBases;
  accounts: Pick<Accounts, "connect">;
  /** the GitHub OAuth app's client ID, injected into builds; absent: sign-in is unavailable */
  githubClientId?: string;
  /** the Bitbucket OAuth consumer, injected into builds; absent: sign-in is unavailable */
  bitbucketClient?: { id: string; secret: string };
}

/** What the user needs to finish a GitHub sign-in: enter `userCode` at `verificationUri` before `expiresAt`. */
export interface GitHubSignIn {
  on: "github";
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  deviceCode: string;
  intervalSeconds: number;
}

/** Open `authorizeUrl` in the browser; Bitbucket redirects back with a code and this `state`. */
export interface BitbucketSignIn {
  on: "bitbucket";
  authorizeUrl: string;
  state: string;
}

// What Loadout needs: clone, push and open PRs on private repos.
const GITHUB_SCOPE = "repo";
const timeoutMs = 15_000;

function cancelled() {
  return err({ code: "CANCELLED" as const, message: "Sign-in was cancelled" });
}

/** Resolves after `ms`, or false at once when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postForm(ctx: SignInCtx, path: string, form: Record<string, string>, signal?: AbortSignal): Promise<Result<Record<string, unknown>>> {
  try {
    const res = await ctx.host.http.request({
      method: "POST",
      url: `${ctx.apiBases.githubLogin}${path}`,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      timeoutMs,
      ...(signal && { signal }),
    });
    if (res.status !== 200) return err({ code: "API_FAILED", message: `GitHub answered HTTP ${res.status} to ${path}` });
    return ok(JSON.parse(res.body) as Record<string, unknown>);
  } catch (e) {
    if (signal?.aborted) return cancelled();
    return err({ code: "API_FAILED", message: `github.com: ${(e as Error).message}` });
  }
}

const describe = (answer: Record<string, unknown>) => String(answer.error_description ?? answer.error);

export async function beginGitHubSignIn(ctx: SignInCtx): Promise<Result<GitHubSignIn>> {
  const clientId = ctx.githubClientId;
  if (clientId === undefined) return err({ code: "SIGN_IN_UNAVAILABLE", message: "This build has no GitHub client ID, so GitHub sign-in is unavailable" });
  const started = await postForm(ctx, "/login/device/code", { client_id: clientId, scope: GITHUB_SCOPE });
  if (!started.ok) return started;
  const a = started.value;
  if (typeof a.device_code !== "string" || typeof a.user_code !== "string" || typeof a.verification_uri !== "string") {
    return err({ code: "API_FAILED", message: `GitHub didn't start the sign-in: ${describe(a)}` });
  }
  const expiresIn = typeof a.expires_in === "number" ? a.expires_in : 900;
  return ok({
    on: "github",
    userCode: a.user_code,
    verificationUri: a.verification_uri,
    expiresAt: new Date(ctx.host.now().getTime() + expiresIn * 1000).toISOString(),
    deviceCode: a.device_code,
    intervalSeconds: typeof a.interval === "number" ? a.interval : 5,
  });
}

/** Polls at GitHub's interval until the user approves (then connects), declines, lets the code lapse, or `signal` aborts. */
export async function completeGitHubSignIn(ctx: SignInCtx, started: GitHubSignIn, opts: { signal?: AbortSignal } = {}): Promise<Result<AccountInfo>> {
  const clientId = ctx.githubClientId;
  if (clientId === undefined) return err({ code: "SIGN_IN_UNAVAILABLE", message: "This build has no GitHub client ID, so GitHub sign-in is unavailable" });
  const expired = err({ code: "SIGN_IN_EXPIRED" as const, message: `The code ${started.userCode} expired before it was entered; start the sign-in again` });
  let interval = started.intervalSeconds;
  for (;;) {
    if (!(await wait(interval * 1000, opts.signal))) return cancelled();
    if (ctx.host.now().getTime() >= Date.parse(started.expiresAt)) return expired;
    const polled = await postForm(
      ctx,
      "/login/oauth/access_token",
      { client_id: clientId, device_code: started.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      opts.signal,
    );
    if (!polled.ok) return polled;
    const a = polled.value;
    if (typeof a.access_token === "string") {
      const scopes = typeof a.scope === "string" ? a.scope.split(",").filter(Boolean) : [];
      return ctx.accounts.connect("github", { accessToken: a.access_token, scopes });
    }
    switch (a.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // GitHub sends the new interval; the spec says add 5 seconds when it doesn't.
        interval = typeof a.interval === "number" ? a.interval : interval + 5;
        continue;
      case "access_denied":
        return err({ code: "SIGN_IN_DENIED", message: "The GitHub sign-in was declined" });
      case "expired_token":
        return expired;
      default:
        return err({ code: "API_FAILED", message: `GitHub sign-in failed: ${describe(a)}` });
    }
  }
}

const bitbucketUnavailable = () =>
  err({ code: "SIGN_IN_UNAVAILABLE" as const, message: "This build has no Bitbucket OAuth consumer, so Bitbucket sign-in is unavailable" });

export function beginBitbucketSignIn(ctx: SignInCtx): Result<BitbucketSignIn> {
  if (ctx.bitbucketClient === undefined) return bitbucketUnavailable();
  // Checked on return, so a redirect Loadout didn't start (another app's, or a stale tab's) is refused.
  const state = crypto.randomUUID();
  const query = new URLSearchParams({ client_id: ctx.bitbucketClient.id, response_type: "code", state });
  return ok({ on: "bitbucket", authorizeUrl: `${ctx.apiBases.bitbucketAuth}/authorize?${query}`, state });
}

/** Takes the redirect Bitbucket sent to loadout://oauth/bitbucket, exchanges its code, and connects. */
export async function completeBitbucketSignIn(ctx: SignInCtx, started: BitbucketSignIn, redirectUrl: string): Promise<Result<AccountInfo>> {
  if (ctx.bitbucketClient === undefined) return bitbucketUnavailable();
  const params = new URL(redirectUrl).searchParams;
  if (params.get("state") !== started.state) {
    return err({ code: "AUTH_FAILED", message: "The Bitbucket redirect doesn't belong to this sign-in; start it again" });
  }
  const denied = params.get("error");
  if (denied === "access_denied") return err({ code: "SIGN_IN_DENIED", message: "The Bitbucket sign-in was declined" });
  const code = params.get("code");
  if (code === null) return err({ code: "API_FAILED", message: `Bitbucket sign-in failed: ${params.get("error_description") ?? denied ?? "no code in the redirect"}` });

  const { id, secret } = ctx.bitbucketClient;
  let res;
  try {
    res = await ctx.host.http.request({
      method: "POST",
      url: `${ctx.apiBases.bitbucketAuth}/access_token`,
      headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
      timeoutMs,
    });
  } catch (e) {
    return err({ code: "API_FAILED", message: `bitbucket.org: ${(e as Error).message}` });
  }
  if (res.status === 400) {
    return err({ code: "SIGN_IN_EXPIRED", message: "Bitbucket no longer accepts that code (they are single-use and short-lived); start the sign-in again" });
  }
  if (res.status !== 200) return err({ code: "API_FAILED", message: `Bitbucket answered HTTP ${res.status} to the code exchange` });
  const a = JSON.parse(res.body) as { access_token: string; refresh_token?: string; expires_in: number; scopes?: string };
  return ctx.accounts.connect("bitbucket", {
    accessToken: a.access_token,
    ...(a.refresh_token !== undefined && { refreshToken: a.refresh_token }),
    expiresAt: new Date(ctx.host.now().getTime() + a.expires_in * 1000).toISOString(),
    ...(a.scopes !== undefined && { scopes: a.scopes.split(" ") }),
  });
}
