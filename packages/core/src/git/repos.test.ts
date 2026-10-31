import { describe, expect, it } from "vitest";
import { createApiStub } from "../../test/apiStub.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { createAccounts } from "../accounts/accounts.ts";
import { createConfigStore } from "../config/config.ts";
import { checkCatalogRepo, listRepos } from "./repos.ts";

/** octo on GitHub and jose on Bitbucket, each reading repos they own and repos they only belong to. */
async function setup() {
  const sb = await createSandbox();
  const stub = await createApiStub();
  const accounts = createAccounts(sb.host, createConfigStore(sb.host), { apiBases: stub.bases });
  const ctx = { host: sb.host, accounts, apiBases: stub.bases };
  stub.addToken("github", "gh-1", "octo");
  stub.addToken("bitbucket", "bb-1", "jose");
  await accounts.connect("github", { accessToken: "gh-1" });
  await accounts.connect("bitbucket", { accessToken: "bb-1" });
  const files = { main: ["library.yaml"], dev: ["catalog/library.yaml"] };
  stub.addRepo("github", { org: "octo", name: "dotfiles", defaultBranch: "main", readers: ["octo"], files: {} });
  stub.addRepo("github", { org: "acme", name: "agentics", defaultBranch: "main", private: true, readers: ["octo", "other"], files });
  stub.addRepo("github", { org: "acme", name: "secret", defaultBranch: "main", readers: ["other"], files });
  stub.addRepo("bitbucket", { org: "myworkspace", name: "agent-library", defaultBranch: "trunk", private: true, readers: ["jose"], files: { trunk: ["library.yaml"] } });
  stub.addRepo("bitbucket", { org: "myworkspace", name: "website", defaultBranch: "main", readers: ["jose"], files: {} });
  stub.addRepo("bitbucket", { org: "jose", name: "scratch", defaultBranch: "main", readers: ["jose"], files: {} });
  stub.addRepo("bitbucket", { org: "elsewhere", name: "hidden", defaultBranch: "main", readers: ["someone"], files: {} });
  return { sb, stub, ctx };
}

describe("listRepos", () => {
  it("GitHub: every repo the account can read, owned or through an org, and none it can't, across pages", async () => {
    const { stub, ctx } = await setup();
    stub.setPageSize(1);
    const listed = await listRepos(ctx, "github");
    expect(listed).toEqual({
      ok: true,
      warnings: [],
      value: [
        { org: "acme", name: "agentics", private: true, repo: "https://github.com/acme/agentics.git" },
        { org: "octo", name: "dotfiles", private: false, repo: "https://github.com/octo/dotfiles.git" },
      ],
    });
    // The stub's page of 1 makes the client follow GitHub's Link header.
    expect(stub.requests.filter((r) => r.path.startsWith("/user/repos")).map((r) => new URLSearchParams(r.path.split("?")[1]).get("page"))).toEqual([null, "2"]);
  });

  it("GitHub: asks for 100 a page", async () => {
    const { stub, ctx } = await setup();
    for (let i = 0; i < 150; i++) stub.addRepo("github", { org: "big", name: `r${String(i).padStart(3, "0")}`, defaultBranch: "main", readers: ["octo"], files: {} });
    const listed = await listRepos(ctx, "github");
    expect(listed.ok && listed.value.length).toBe(152);
    expect(stub.requests.filter((r) => r.path.startsWith("/user/repos")).length).toBe(2);
  });

  it("Bitbucket: the repos of each of the account's workspaces it's a member of, following next links", async () => {
    const { stub, ctx } = await setup();
    stub.setPageSize(1);
    const listed = await listRepos(ctx, "bitbucket");
    expect(listed.ok && listed.value).toEqual([
      { org: "jose", name: "scratch", private: false, repo: "https://bitbucket.org/jose/scratch.git" },
      { org: "myworkspace", name: "agent-library", private: true, repo: "https://bitbucket.org/myworkspace/agent-library.git" },
      { org: "myworkspace", name: "website", private: false, repo: "https://bitbucket.org/myworkspace/website.git" },
    ]);
    expect(stub.requests.filter((r) => r.path.startsWith("/repositories/myworkspace?")).every((r) => r.path.includes("role=member"))).toBe(true);
  });

  it("is NOT_CONNECTED without an account, and AUTH_FAILED when the host refuses the token", async () => {
    const { stub, ctx } = await setup();
    await ctx.accounts.disconnect("github");
    expect(await listRepos(ctx, "github")).toMatchObject({ ok: false, error: { code: "NOT_CONNECTED" } });
    stub.failNext({ api: "bitbucket", path: "/user/workspaces?pagelen=100" }, 401, { type: "error", error: { message: "Token is invalid" } });
    expect(await listRepos(ctx, "bitbucket")).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
  });
});

describe("checkCatalogRepo", () => {
  it("GitHub: the default branch, and library.yaml found at the root of it", async () => {
    const { ctx } = await setup();
    expect(await checkCatalogRepo(ctx, { on: "github", org: "acme", name: "agentics" })).toEqual({
      ok: true,
      warnings: [],
      value: { defaultBranch: "main", branch: "main", yamlPath: "library.yaml", found: true },
    });
  });

  it("GitHub: a branch and path from a deep link are checked as given", async () => {
    const { ctx } = await setup();
    const at = (branch: string, yamlPath: string) => checkCatalogRepo(ctx, { on: "github", org: "acme", name: "agentics", branch, yamlPath });
    expect(await at("dev", "catalog/library.yaml")).toMatchObject({ ok: true, value: { defaultBranch: "main", branch: "dev", found: true } });
    expect(await at("dev", "library.yaml")).toMatchObject({ ok: true, value: { found: false } });
  });

  it("Bitbucket: the main branch, and a repo without library.yaml says so", async () => {
    const { ctx } = await setup();
    expect(await checkCatalogRepo(ctx, { on: "bitbucket", org: "myworkspace", name: "agent-library" })).toMatchObject({ ok: true, value: { defaultBranch: "trunk", branch: "trunk", found: true } });
    expect(await checkCatalogRepo(ctx, { on: "bitbucket", org: "myworkspace", name: "website" })).toMatchObject({ ok: true, value: { branch: "main", found: false } });
  });

  it("a repo the account can't read is NOT_FOUND, saying access may be what's missing", async () => {
    const { ctx } = await setup();
    const gh = await checkCatalogRepo(ctx, { on: "github", org: "acme", name: "secret" });
    expect(gh).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: expect.stringContaining("restricts OAuth apps") } });
    expect(await checkCatalogRepo(ctx, { on: "bitbucket", org: "elsewhere", name: "hidden" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Bitbucket shows no elsewhere/hidden to this account: it doesn't exist, or the account can't read it" },
    });
  });
});
