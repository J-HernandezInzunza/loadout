import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../src/host.ts";
import { createApiStub } from "./apiStub.ts";
import { createSandbox } from "./sandbox.ts";

async function setup() {
  const sb = await createSandbox();
  const stub = await createApiStub();
  const call = async (req: HttpRequest) => {
    const res = await sb.host.http.request(req);
    return { status: res.status, headers: res.headers, json: res.body === "" ? undefined : (JSON.parse(res.body) as unknown) };
  };
  return { stub, call };
}

const json = { "Content-Type": "application/json" };

describe("API stub: GitHub", () => {
  it("answers GET /user for a known token, and 401 for an unknown or expired one", async () => {
    const { stub, call } = await setup();
    stub.addToken("github", "gh-1", "octo", ["repo"]);
    const url = `${stub.bases.github}/user`;

    const ok = await call({ method: "GET", url, headers: { Authorization: "Bearer gh-1" } });
    expect(ok).toMatchObject({ status: 200, json: { login: "octo" }, headers: { "x-oauth-scopes": "repo" } });

    expect(await call({ method: "GET", url, headers: { Authorization: "Bearer nope" } })).toMatchObject({
      status: 401,
      json: { message: "Bad credentials" },
    });
    stub.expireToken("gh-1");
    expect((await call({ method: "GET", url, headers: { Authorization: "Bearer gh-1" } })).status).toBe(401);
  });

  it("creates a PR, answers a duplicate with 422, and lists open PRs by head", async () => {
    const { stub, call } = await setup();
    stub.addToken("github", "gh-1", "octo");
    const headers = { Authorization: "Bearer gh-1", ...json };
    const url = `${stub.bases.github}/repos/o/r/pulls`;
    const body = JSON.stringify({ title: "Add x", head: "library/add-x", base: "main", body: "why" });

    const created = await call({ method: "POST", url, headers, body });
    expect(created).toMatchObject({
      status: 201,
      json: { number: 1, html_url: "https://github.com/o/r/pull/1", state: "open", head: { ref: "library/add-x" } },
    });

    const dup = await call({ method: "POST", url, headers, body });
    expect(dup).toMatchObject({
      status: 422,
      json: { message: "Validation Failed", errors: [{ message: "A pull request already exists for o:library/add-x." }] },
    });

    const listed = await call({ method: "GET", url: `${url}?head=o:library/add-x&state=open`, headers });
    expect(listed).toMatchObject({ status: 200, json: [{ html_url: "https://github.com/o/r/pull/1" }] });
    expect((await call({ method: "GET", url: `${url}?head=o:other`, headers })).json).toEqual([]);
    expect(stub.pulls("github")).toHaveLength(1);
  });
});

describe("API stub: Bitbucket", () => {
  it("answers GET /user, with distinct invalid and expired 401s", async () => {
    const { stub, call } = await setup();
    stub.addToken("bitbucket", "bb-1", "jose");
    const url = `${stub.bases.bitbucket}/user`;

    expect(await call({ method: "GET", url, headers: { Authorization: "Bearer bb-1" } })).toMatchObject({
      status: 200,
      json: { username: "jose" },
    });
    // A GitHub token is not a Bitbucket token.
    stub.addToken("github", "gh-1", "octo");
    expect(await call({ method: "GET", url, headers: { Authorization: "Bearer gh-1" } })).toMatchObject({
      status: 401,
      json: { type: "error", error: { message: "Token is invalid or not supported for this endpoint." } },
    });
    stub.expireToken("bb-1");
    expect(await call({ method: "GET", url, headers: { Authorization: "Bearer bb-1" } })).toMatchObject({
      status: 401,
      json: { error: { message: "Access token expired." } },
    });
  });

  it("refreshes a token with the refresh grant and client credentials", async () => {
    const { stub, call } = await setup();
    stub.addRefreshToken("rt-1", "jose");
    const url = `${stub.bases.bitbucketAuth}/access_token`;
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const basic = { Authorization: `Basic ${btoa("client:secret")}`, ...form };

    const res = await call({ method: "POST", url, headers: basic, body: "grant_type=refresh_token&refresh_token=rt-1" });
    expect(res).toMatchObject({ status: 200, json: { refresh_token: "rt-1", expires_in: 7200, token_type: "bearer" } });
    const access = (res.json as { access_token: string }).access_token;
    const user = await call({ method: "GET", url: `${stub.bases.bitbucket}/user`, headers: { Authorization: `Bearer ${access}` } });
    expect(user).toMatchObject({ status: 200, json: { username: "jose" } });

    expect(
      await call({ method: "POST", url, headers: basic, body: "grant_type=refresh_token&refresh_token=rt-x" }),
    ).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect(
      await call({ method: "POST", url, headers: form, body: "grant_type=refresh_token&refresh_token=rt-1" }),
    ).toMatchObject({ status: 401, json: { error: "invalid_client" } });
  });

  it("creates a PR, refuses a duplicate with 400, and lists open PRs by source branch", async () => {
    const { stub, call } = await setup();
    stub.addToken("bitbucket", "bb-1", "jose");
    const headers = { Authorization: "Bearer bb-1", ...json };
    const url = `${stub.bases.bitbucket}/repositories/ws/repo/pullrequests`;
    const body = JSON.stringify({
      title: "Add x",
      description: "why",
      source: { branch: { name: "library/add-x" } },
      destination: { branch: { name: "main" } },
    });

    expect(await call({ method: "POST", url, headers, body })).toMatchObject({
      status: 201,
      json: { id: 1, state: "OPEN", links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/1" } } },
    });
    expect(await call({ method: "POST", url, headers, body })).toMatchObject({ status: 400, json: { type: "error" } });

    const q = encodeURIComponent('source.branch.name="library/add-x" AND state="OPEN"');
    expect(await call({ method: "GET", url: `${url}?q=${q}`, headers })).toMatchObject({
      status: 200,
      json: { size: 1, values: [{ id: 1, source: { branch: { name: "library/add-x" } } }] },
    });
    const unsupported = encodeURIComponent('author.uuid="{x}"');
    expect((await call({ method: "GET", url: `${url}?q=${unsupported}`, headers })).status).toBe(400);
  });
});

describe("API stub: recording and failures", () => {
  it("records every request relative to its api base", async () => {
    const { stub, call } = await setup();
    stub.addToken("github", "gh-1", "octo");
    await call({ method: "GET", url: `${stub.bases.github}/user?x=1`, headers: { Authorization: "Bearer gh-1" } });
    await call({ method: "POST", url: `${stub.bases.bitbucketAuth}/access_token`, body: "grant_type=refresh_token" });
    expect(stub.requests).toEqual([
      expect.objectContaining({
        api: "github",
        method: "GET",
        path: "/user?x=1",
        headers: expect.objectContaining({ authorization: "Bearer gh-1" }),
        body: "",
      }),
      expect.objectContaining({ api: "bitbucketAuth", method: "POST", path: "/access_token", body: "grant_type=refresh_token" }),
    ]);
  });

  it("fails the next matching request once, then answers normally", async () => {
    const { stub, call } = await setup();
    stub.addToken("github", "gh-1", "octo");
    const req = { method: "GET", url: `${stub.bases.github}/user`, headers: { Authorization: "Bearer gh-1" } } as const;
    stub.failNext({ api: "bitbucket" }, 500);
    stub.failNext({ api: "github", method: "GET", path: "/user" }, 503, { message: "Service Unavailable" });

    expect(await call(req)).toMatchObject({ status: 503, json: { message: "Service Unavailable" } });
    expect((await call(req)).status).toBe(200);
    expect(stub.requests).toHaveLength(2);
  });
});
