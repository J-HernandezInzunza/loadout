import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createAccounts } from "./accounts.ts";
import { beginBitbucketSignIn, beginGitHubSignIn, completeBitbucketSignIn, completeGitHubSignIn, type SignInCtx } from "./signIn.ts";

const t0 = new Date("2026-10-29T12:00:00.000Z");

const bitbucketClient = { id: "bb-key", secret: "bb-secret" };

/** `githubClientId` null: a build without one; `bitbucket` false: a build without the consumer. */
async function setup(githubClientId: string | null = "gh-client", bitbucket = true) {
  const sb = await createSandbox();
  const stub = await createApiStub();
  const clock = { now: t0 };
  const host = { ...sb.host, now: () => clock.now };
  const store = createConfigStore(host);
  const accounts = createAccounts(host, store, { apiBases: stub.bases, ...(bitbucket && { bitbucketClient }) });
  const ctx: SignInCtx = {
    host,
    apiBases: stub.bases,
    accounts,
    ...(githubClientId !== null && { githubClientId }),
    ...(bitbucket && { bitbucketClient }),
  };
  const begin = async () => {
    const started = await beginGitHubSignIn(ctx);
    if (!started.ok) throw new Error(started.error.message);
    return started.value;
  };
  return { sb, stub, host, clock, accounts, ctx, begin };
}

const later = (f: () => void) => setTimeout(f, 20);

describe("GitHub sign-in (device flow)", () => {
  it("shows a code, then connects the account once the user approves it", async () => {
    const { sb, stub, host, accounts, ctx, begin } = await setup();
    const started = await begin();
    expect(started).toEqual({
      on: "github",
      userCode: "CODE-0001",
      verificationUri: "https://github.com/login/device",
      expiresAt: "2026-10-29T12:15:00.000Z",
      deviceCode: "device-1",
      intervalSeconds: 0,
    });

    later(() => stub.approveDevice("CODE-0001", "octo", ["repo"]));
    const connected = await completeGitHubSignIn(ctx, started);
    expect(connected).toEqual({ ok: true, value: { login: "octo", scopes: ["repo"], connectedAt: t0.toISOString() }, warnings: [] });
    expect(await accounts.accounts()).toMatchObject({ ok: true, value: { github: { login: "octo" } } });
    expect(JSON.parse((await host.secrets.get("github"))!)).toEqual({ accessToken: "gh-access-1", scopes: ["repo"] });

    const login = stub.requests.filter((r) => r.api === "githubLogin");
    expect(Object.fromEntries(new URLSearchParams(login[0]!.body))).toEqual({ client_id: "gh-client", scope: "repo" });
    expect(Object.fromEntries(new URLSearchParams(login.at(-1)!.body))).toEqual({
      client_id: "gh-client",
      device_code: "device-1",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(login.every((r) => r.method === "POST" && r.headers.accept === "application/json")).toBe(true);
    expect(JSON.stringify(sb.audit)).not.toContain("gh-access-1");
  });

  it("keeps polling through slow_down", async () => {
    const { stub, ctx, begin } = await setup();
    const started = await begin();
    stub.slowDownDevice("CODE-0001");
    later(() => stub.approveDevice("CODE-0001", "octo"));
    expect(await completeGitHubSignIn(ctx, started)).toMatchObject({ ok: true, value: { login: "octo" } });
    expect(stub.requests.some((r) => r.path === "/login/oauth/access_token")).toBe(true);
  });

  it("a declined sign-in is SIGN_IN_DENIED and stores nothing", async () => {
    const { stub, host, ctx, begin } = await setup();
    const started = await begin();
    later(() => stub.denyDevice("CODE-0001"));
    expect(await completeGitHubSignIn(ctx, started)).toMatchObject({ ok: false, error: { code: "SIGN_IN_DENIED" } });
    expect(await host.secrets.get("github")).toBeNull();
  });

  it("a code that lapses is SIGN_IN_EXPIRED, whether GitHub says so or the clock does", async () => {
    const { stub, clock, ctx, begin } = await setup();
    const first = await begin();
    later(() => stub.expireDevice("CODE-0001"));
    expect(await completeGitHubSignIn(ctx, first)).toMatchObject({ ok: false, error: { code: "SIGN_IN_EXPIRED", message: expect.stringContaining("start the sign-in again") } });

    const second = await begin();
    clock.now = new Date(t0.getTime() + 16 * 60_000);
    expect(await completeGitHubSignIn(ctx, second)).toMatchObject({ ok: false, error: { code: "SIGN_IN_EXPIRED" } });
  });

  it("an abort stops the polling with CANCELLED", async () => {
    const { ctx, begin } = await setup();
    const started = await begin();
    const controller = new AbortController();
    later(() => controller.abort());
    expect(await completeGitHubSignIn(ctx, started, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });

  it("is SIGN_IN_UNAVAILABLE without a client ID, and API_FAILED when GitHub rejects the one given", async () => {
    const without = await setup(null);
    expect(await beginGitHubSignIn(without.ctx)).toMatchObject({ ok: false, error: { code: "SIGN_IN_UNAVAILABLE" } });
    expect(without.stub.requests).toEqual([]);

    const wrong = await setup("someone-else");
    expect(await beginGitHubSignIn(wrong.ctx)).toMatchObject({ ok: false, error: { code: "API_FAILED", message: expect.stringContaining("incorrect_client_credentials") } });
  });
});

describe("Bitbucket sign-in (authorization code to loadout://)", () => {
  const redirect = (query: Record<string, string>) => `loadout://oauth/bitbucket?${new URLSearchParams(query)}`;

  it("opens the consent page with a fresh state, exchanges the redirect's code, connects, and refreshes later", async () => {
    const { sb, stub, host, clock, accounts, ctx } = await setup();
    const started = beginBitbucketSignIn(ctx);
    if (!started.ok) throw new Error(started.error.message);
    const url = new URL(started.value.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${stub.bases.bitbucketAuth}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "bb-key", response_type: "code", state: started.value.state });
    expect(beginBitbucketSignIn(ctx)).not.toMatchObject({ value: { state: started.value.state } });

    stub.addAuthCode("code-1", "jose");
    const connected = await completeBitbucketSignIn(ctx, started.value, redirect({ code: "code-1", state: started.value.state }));
    expect(connected).toMatchObject({ ok: true, value: { login: "jose", connectedAt: t0.toISOString() } });
    const exchange = stub.requests.find((r) => r.api === "bitbucketAuth")!;
    expect(exchange.headers.authorization).toBe(`Basic ${btoa("bb-key:bb-secret")}`);
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({ grant_type: "authorization_code", code: "code-1" });
    const stored = JSON.parse((await host.secrets.get("bitbucket"))!);
    expect(stored).toMatchObject({ accessToken: "bb-access-1", refreshToken: "bb-refresh-1", expiresAt: "2026-10-29T14:00:00.000Z" });

    // Two hours on, the access token has lapsed and M2.04 refreshes it with the stored refresh token.
    clock.now = new Date(t0.getTime() + 3 * 3_600_000);
    expect(await accounts.tokenFor("bitbucket")).toEqual({ ok: true, value: "bb-access-2", warnings: [] });
    expect(JSON.stringify(sb.audit)).not.toContain("bb-access");
  });

  it("refuses a redirect whose state isn't this sign-in's, before any exchange", async () => {
    const { stub, ctx } = await setup();
    const started = beginBitbucketSignIn(ctx);
    if (!started.ok) throw new Error(started.error.message);
    stub.addAuthCode("code-1", "jose");
    expect(await completeBitbucketSignIn(ctx, started.value, redirect({ code: "code-1", state: "someone-elses" }))).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED" },
    });
    expect(stub.requests).toEqual([]);
  });

  it("a declined consent is SIGN_IN_DENIED, and a used or stale code is SIGN_IN_EXPIRED", async () => {
    const { stub, host, ctx } = await setup();
    const started = beginBitbucketSignIn(ctx);
    if (!started.ok) throw new Error(started.error.message);
    const { state } = started.value;
    expect(await completeBitbucketSignIn(ctx, started.value, redirect({ error: "access_denied", state }))).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_DENIED" },
    });

    stub.addAuthCode("code-1", "jose");
    expect(await completeBitbucketSignIn(ctx, started.value, redirect({ code: "code-1", state }))).toMatchObject({ ok: true });
    expect(await completeBitbucketSignIn(ctx, started.value, redirect({ code: "code-1", state }))).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_EXPIRED", message: expect.stringContaining("start the sign-in again") },
    });
    expect(await host.secrets.get("bitbucket")).not.toBeNull();
  });

  it("a build without the consumer reports Bitbucket sign-in unavailable", async () => {
    const { stub, ctx } = await setup("gh-client", false);
    expect(beginBitbucketSignIn(ctx)).toMatchObject({ ok: false, error: { code: "SIGN_IN_UNAVAILABLE" } });
    expect(stub.requests).toEqual([]);
  });
});
