import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createConfigStore } from "../config/config.ts";
import { createAccounts, type AccountsOptions } from "./accounts.ts";

const t0 = new Date("2026-10-28T12:00:00.000Z");

async function setup(opts: Omit<AccountsOptions, "apiBases"> = {}) {
  const sb = await createSandbox();
  const stub = await createApiStub();
  const clock = { now: t0 };
  const host = { ...sb.host, now: () => clock.now };
  const store = createConfigStore(host);
  const accounts = createAccounts(host, store, { apiBases: stub.bases, ...opts });
  const configText = () => readFile(join(host.paths.appData, "config.json"), "utf8");
  return { sb, stub, host, clock, store, accounts, configText };
}

const hours = (n: number) => n * 3_600_000;

describe("accounts", () => {
  it("connects a GitHub account: token in secrets, login and scopes in config, never the token", async () => {
    const { sb, stub, host, accounts, configText } = await setup();
    stub.addToken("github", "gh-secret-1", "octo", ["repo", "read:user"]);

    const connected = await accounts.connect("github", { accessToken: "gh-secret-1" });
    const info = { login: "octo", scopes: ["repo", "read:user"], connectedAt: t0.toISOString() };
    expect(connected).toEqual({ ok: true, value: info, warnings: [] });
    expect(await accounts.accounts()).toMatchObject({ ok: true, value: { github: info } });
    expect(await accounts.tokenFor("github")).toMatchObject({ ok: true, value: "gh-secret-1" });
    expect(JSON.parse((await host.secrets.get("github"))!)).toEqual({ accessToken: "gh-secret-1" });

    expect(stub.requests).toEqual([
      expect.objectContaining({ api: "github", path: "/user", headers: expect.objectContaining({ authorization: "Bearer gh-secret-1" }) }),
    ]);
    expect(await configText()).not.toContain("gh-secret-1");
    expect(JSON.stringify(sb.audit)).not.toContain("gh-secret-1");
  });

  it("refuses an invalid token with AUTH_FAILED and stores nothing", async () => {
    const { host, accounts } = await setup();
    expect(await accounts.connect("github", { accessToken: "nope" })).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("GitHub rejected the token (HTTP 401)") },
    });
    expect(await host.secrets.get("github")).toBeNull();
    expect(await accounts.accounts()).toMatchObject({ ok: true, value: {} });
  });

  it("whoami validates a token without connecting it", async () => {
    const { stub, accounts } = await setup();
    stub.addToken("bitbucket", "bb-1", "jose");
    expect(await accounts.whoami("bitbucket", "bb-1")).toMatchObject({ ok: true, value: { login: "jose", scopes: null } });
    expect(await accounts.whoami("bitbucket", "gone")).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
    expect(await accounts.accounts()).toMatchObject({ ok: true, value: {} });
  });

  it("connects Bitbucket with the scopes from the token response", async () => {
    const { stub, accounts } = await setup();
    stub.addToken("bitbucket", "bb-1", "jose");
    const connected = await accounts.connect("bitbucket", {
      accessToken: "bb-1",
      refreshToken: "rt-1",
      expiresAt: new Date(t0.getTime() + hours(2)).toISOString(),
      scopes: ["repository:write", "pullrequest:write"],
    });
    expect(connected).toMatchObject({ ok: true, value: { login: "jose", scopes: ["repository:write", "pullrequest:write"] } });
  });

  it("refreshes an expired Bitbucket token once, with the client's credentials, and keeps it secret", async () => {
    const { sb, stub, host, clock, accounts, configText } = await setup({ bitbucketClient: { id: "cid", secret: "csecret" } });
    stub.addToken("bitbucket", "bb-1", "jose");
    stub.addRefreshToken("rt-1", "jose");
    await accounts.connect("bitbucket", {
      accessToken: "bb-1",
      refreshToken: "rt-1",
      expiresAt: new Date(t0.getTime() + hours(2)).toISOString(),
    });

    expect(await accounts.tokenFor("bitbucket")).toMatchObject({ ok: true, value: "bb-1" });
    clock.now = new Date(t0.getTime() + hours(2) - 30_000); // inside the refresh margin
    const fresh = await accounts.tokenFor("bitbucket");
    expect(fresh).toMatchObject({ ok: true, value: "bb-access-1" });
    expect(await accounts.tokenFor("bitbucket")).toMatchObject({ ok: true, value: "bb-access-1" });

    const refreshes = stub.requests.filter((r) => r.api === "bitbucketAuth");
    expect(refreshes).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/access_token",
        headers: expect.objectContaining({ authorization: `Basic ${btoa("cid:csecret")}` }),
        body: "grant_type=refresh_token&refresh_token=rt-1",
      }),
    ]);
    expect(JSON.parse((await host.secrets.get("bitbucket"))!)).toEqual({
      accessToken: "bb-access-1",
      refreshToken: "rt-1",
      expiresAt: new Date(clock.now.getTime() + hours(2)).toISOString(),
      scopes: ["account", "repository:write", "pullrequest:write"],
    });
    for (const secret of ["bb-1", "rt-1", "bb-access-1", "csecret"]) {
      expect(await configText()).not.toContain(secret);
      expect(JSON.stringify(sb.audit)).not.toContain(secret);
    }
  });

  it.each([
    ["the refresh token is refused", { bitbucketClient: { id: "cid", secret: "s" } }, "rt-unknown", "the refresh was refused (HTTP 400)"],
    ["the build has no client", {}, "rt-1", "this build has no Bitbucket client"],
    ["there is no refresh token", { bitbucketClient: { id: "cid", secret: "s" } }, undefined, "there is no refresh token"],
  ])("asks to reconnect when an expired Bitbucket token can't be refreshed: %s", async (_, opts, refreshToken, why) => {
    const { stub, clock, accounts } = await setup(opts);
    stub.addToken("bitbucket", "bb-1", "jose");
    stub.addRefreshToken("rt-1", "jose");
    await accounts.connect("bitbucket", {
      accessToken: "bb-1",
      ...(refreshToken !== undefined && { refreshToken }),
      expiresAt: new Date(t0.getTime() + hours(2)).toISOString(),
    });
    clock.now = new Date(t0.getTime() + hours(3));
    expect(await accounts.tokenFor("bitbucket")).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining(why) },
    });
  });

  it("disconnects: token and facts gone, and a second disconnect still succeeds", async () => {
    const { stub, host, accounts, configText } = await setup();
    stub.addToken("github", "gh-1", "octo");
    stub.addToken("bitbucket", "bb-1", "jose");
    await accounts.connect("github", { accessToken: "gh-1" });
    await accounts.connect("bitbucket", { accessToken: "bb-1" });

    expect(await accounts.disconnect("github")).toMatchObject({ ok: true });
    expect(await accounts.disconnect("github")).toMatchObject({ ok: true });
    expect(await host.secrets.get("github")).toBeNull();
    expect(await accounts.tokenFor("github")).toMatchObject({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "No GitHub account is connected" },
    });
    expect(Object.keys(JSON.parse(await configText()).accounts)).toEqual(["bitbucket"]);
  });

  it("lands two concurrent connects in config", async () => {
    const { stub, accounts } = await setup();
    stub.addToken("github", "gh-1", "octo");
    stub.addToken("bitbucket", "bb-1", "jose");
    await Promise.all([accounts.connect("github", { accessToken: "gh-1" }), accounts.connect("bitbucket", { accessToken: "bb-1" })]);
    expect(await accounts.accounts()).toMatchObject({ ok: true, value: { github: { login: "octo" }, bitbucket: { login: "jose" } } });
  });

  it("reports a server error or an unreachable host as API_FAILED", async () => {
    const { sb, stub, accounts } = await setup();
    stub.addToken("github", "gh-1", "octo");
    stub.failNext({ api: "github", path: "/user" }, 502);
    expect(await accounts.connect("github", { accessToken: "gh-1" })).toMatchObject({
      ok: false,
      error: { code: "API_FAILED", message: "GitHub answered HTTP 502 to the user lookup" },
    });

    const offline = createAccounts({ ...sb.host, http: { request: () => Promise.reject(new TypeError("fetch failed")) } }, createConfigStore(sb.host), {
      apiBases: stub.bases,
    });
    expect(await offline.whoami("github", "gh-1")).toMatchObject({
      ok: false,
      error: { code: "API_FAILED", message: expect.stringContaining("fetch failed") },
    });
  });

  it("leaves no token behind when config.json can't be saved", async () => {
    const { stub, host, accounts } = await setup();
    stub.addToken("github", "gh-1", "octo");
    await host.fs.writeTextAtomic(join(host.paths.appData, "config.json"), "{");
    expect(await accounts.connect("github", { accessToken: "gh-1" })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await host.secrets.get("github")).toBeNull();
  });

  it("treats an unreadable stored token as not connected", async () => {
    const { host, accounts } = await setup();
    await host.secrets.set("github", "not json");
    expect(await accounts.tokenFor("github")).toMatchObject({ ok: false, error: { code: "NOT_CONNECTED" } });
  });
});
