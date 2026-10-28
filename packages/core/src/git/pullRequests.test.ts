import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createAccounts } from "../accounts/accounts.ts";
import { createConfigStore } from "../config/config.ts";
import { createPullRequest, type PullRequestRepo } from "./pullRequests.ts";

const t0 = new Date("2026-10-28T12:00:00.000Z");

async function setup() {
  const sb = await createSandbox();
  const stub = await createApiStub();
  const clock = { now: t0 };
  const host = { ...sb.host, now: () => clock.now };
  const accounts = createAccounts(host, createConfigStore(host), { apiBases: stub.bases, bitbucketClient: { id: "cid", secret: "cs" } });
  const open = (repo: PullRequestRepo, head = "library/add-x") =>
    createPullRequest({ host, accounts, apiBases: stub.bases }, repo, { base: "main", head, title: "library: add skill x", body: "Adds x." });
  return { sb, stub, clock, accounts, open };
}

const gh: PullRequestRepo = { kind: "github", org: "o", repo: "r" };
const bb: PullRequestRepo = { kind: "bitbucket", org: "ws", repo: "lib" };

describe("createPullRequest", () => {
  it("GitHub: creates the PR with the account's token and returns its URL", async () => {
    const { stub, accounts, open } = await setup();
    stub.addToken("github", "gh-1", "octo");
    await accounts.connect("github", { accessToken: "gh-1" });

    expect(await open(gh)).toEqual({ ok: true, value: { url: "https://github.com/o/r/pull/1", number: 1, existing: false }, warnings: [] });
    const post = stub.requests.find((r) => r.method === "POST")!;
    expect(post).toMatchObject({ api: "github", path: "/repos/o/r/pulls", headers: expect.objectContaining({ authorization: "Bearer gh-1" }) });
    expect(JSON.parse(post.body)).toEqual({ title: "library: add skill x", head: "library/add-x", base: "main", body: "Adds x." });
  });

  it("Bitbucket: creates the PR with source and destination branches", async () => {
    const { stub, accounts, open } = await setup();
    stub.addToken("bitbucket", "bb-1", "jose");
    await accounts.connect("bitbucket", { accessToken: "bb-1" });

    expect(await open(bb)).toEqual({ ok: true, value: { url: "https://bitbucket.org/ws/lib/pull-requests/1", number: 1, existing: false }, warnings: [] });
    expect(JSON.parse(stub.requests.find((r) => r.method === "POST")!.body)).toEqual({
      title: "library: add skill x",
      description: "Adds x.",
      source: { branch: { name: "library/add-x" } },
      destination: { branch: { name: "main" } },
    });
  });

  it.each([
    ["GitHub", gh, "github", "https://github.com/o/r/pull/1"],
    ["Bitbucket", bb, "bitbucket", "https://bitbucket.org/ws/lib/pull-requests/1"],
  ] as const)("Q2: %s: a PR that already exists for the branch is success with its URL", async (_, repo, kind, url) => {
    const { stub, accounts, open } = await setup();
    stub.addToken(kind, "tok", "me");
    await accounts.connect(kind, { accessToken: "tok" });
    await open(repo);
    expect(await open(repo)).toEqual({ ok: true, value: { url, number: 1, existing: true }, warnings: [] });
    expect(stub.pulls(kind)).toHaveLength(1);
  });

  it("refreshes an expired Bitbucket token before opening the PR", async () => {
    const { stub, clock, accounts, open } = await setup();
    stub.addToken("bitbucket", "bb-old", "jose");
    stub.addRefreshToken("rt-1", "jose");
    await accounts.connect("bitbucket", { accessToken: "bb-old", refreshToken: "rt-1", expiresAt: new Date(t0.getTime() + 3_600_000).toISOString() });
    stub.expireToken("bb-old");
    clock.now = new Date(t0.getTime() + 2 * 3_600_000);

    expect(await open(bb)).toMatchObject({ ok: true, value: { existing: false } });
    expect(stub.requests.map((r) => `${r.api} ${r.method} ${r.path}`)).toEqual([
      "bitbucket GET /user",
      "bitbucketAuth POST /access_token",
      "bitbucket POST /repositories/ws/lib/pullrequests",
    ]);
    expect(stub.requests.at(-1)!.headers.authorization).toBe("Bearer bb-access-1");
  });

  it.each([
    ["GitHub", gh, "github"],
    ["Bitbucket", bb, "bitbucket"],
  ] as const)("%s: a server error is API_FAILED with the host's message; a refused token is AUTH_FAILED", async (_, repo, kind) => {
    const { stub, accounts, open } = await setup();
    stub.addToken(kind, "tok", "me");
    await accounts.connect(kind, { accessToken: "tok" });
    stub.failNext({ api: kind, method: "POST" }, 500, kind === "github" ? { message: "Server Error" } : { type: "error", error: { message: "Something broke" } });
    expect(await open(repo)).toMatchObject({
      ok: false,
      error: { code: "API_FAILED", message: expect.stringMatching(/answered HTTP 500 to creating the pull request: (Server Error|Something broke)$/) },
    });
    stub.expireToken("tok");
    expect(await open(repo)).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
  });

  it("a validation error that isn't a duplicate is API_FAILED, not success", async () => {
    const { stub, accounts, open } = await setup();
    stub.addToken("github", "gh-1", "octo");
    await accounts.connect("github", { accessToken: "gh-1" });
    stub.failNext({ api: "github", method: "POST" }, 422, { message: "Validation Failed", errors: [{ message: "No commits between main and library/add-x" }] });
    expect(await open(gh)).toMatchObject({ ok: false, error: { code: "API_FAILED", message: expect.stringContaining("Validation Failed") } });
  });

  it("without a connected account, says so instead of calling the host", async () => {
    const { stub, open } = await setup();
    expect(await open(gh)).toMatchObject({ ok: false, error: { code: "NOT_CONNECTED" } });
    expect(stub.requests).toEqual([]);
  });
});
