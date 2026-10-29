// The repositories a connected account can read, and whether one holds a catalog (M6.07). Read only:
// adding the catalog still goes through planAddCatalog, which clones to prove it works.
import type { AccountHost } from "../accounts/accounts.ts";
import { err, ok, type Result } from "../model/model.ts";
import { HOST_LABELS, hostApi, type HostApi, type HostApiCtx } from "./hostApi.ts";

export interface HostedRepo {
  /** GitHub owner or Bitbucket workspace */
  org: string;
  name: string;
  private: boolean;
  /** what registering it stores; clones go https first with the account's token (FETCH-02) */
  repo: string;
}

export interface CatalogRepo {
  defaultBranch: string;
  branch: string;
  yamlPath: string;
  /** `yamlPath` exists on `branch` */
  found: boolean;
}

// Enough for any one person's repos; a list longer than this is cut off rather than paged forever.
const MAX_PAGES = 20;
const webHost: Record<AccountHost, string> = { github: "github.com", bitbucket: "bitbucket.org" };

const hosted = (on: AccountHost, org: string, name: string, isPrivate: boolean): HostedRepo => ({
  org,
  name,
  private: isPrivate,
  repo: `https://${webHost[on]}/${org}/${name}.git`,
});

async function getJson<T>(api: HostApi, url: string, what: string): Promise<Result<{ data: T; next?: string }>> {
  const res = await api.call({ method: "GET", url, headers: api.headers });
  if (!res.ok) return res;
  if (res.value.status !== 200) return api.failed(res.value, what);
  // GitHub pages through its Link header; Bitbucket's pages say `next` in the body instead.
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.value.headers.link ?? "")?.[1];
  return ok({ data: JSON.parse(res.value.body) as T, ...(next !== undefined && { next }) });
}

/** Every page, following each one's link to the next. */
async function bitbucketPages<T>(api: HostApi, first: string, what: string): Promise<Result<T[]>> {
  const out: T[] = [];
  let next: string | undefined = first;
  for (let page = 0; next !== undefined && page < MAX_PAGES; page++) {
    const got: Result<{ data: { values: T[]; next?: string } }> = await getJson(api, next, what);
    if (!got.ok) return got;
    out.push(...got.value.data.values);
    next = got.value.data.next;
  }
  return ok(out);
}

/**
 * Every repository the account can read, owned or not: GitHub's own, collaborator and organization repos;
 * Bitbucket's repos with any role in each of the account's workspaces. Sorted by org, then name.
 */
export async function listRepos(ctx: HostApiCtx, on: AccountHost, opts: { signal?: AbortSignal } = {}): Promise<Result<HostedRepo[]>> {
  const api = await hostApi(ctx, on, opts.signal);
  if (!api.ok) return api;
  const { bases } = api.value;
  const repos: HostedRepo[] = [];
  if (on === "github") {
    type Repo = { name: string; owner: { login: string }; private: boolean };
    let next: string | undefined = `${bases.github}/user/repos?per_page=100&affiliation=owner,collaborator,organization_member`;
    for (let page = 0; next !== undefined && page < MAX_PAGES; page++) {
      const got: Result<{ data: Repo[]; next?: string }> = await getJson(api.value, next, "listing repositories");
      if (!got.ok) return got;
      repos.push(...got.value.data.map((r) => hosted(on, r.owner.login, r.name, r.private)));
      next = got.value.next;
    }
  } else {
    type Access = { workspace: { slug: string } };
    const workspaces = await bitbucketPages<Access>(api.value, `${bases.bitbucket}/user/workspaces?pagelen=100`, "listing workspaces");
    if (!workspaces.ok) return workspaces;
    type Repo = { slug: string; is_private: boolean; workspace: { slug: string } };
    for (const { workspace } of workspaces.value) {
      const got = await bitbucketPages<Repo>(api.value, `${bases.bitbucket}/repositories/${encodeURIComponent(workspace.slug)}?role=member&pagelen=100`, `listing ${workspace.slug}'s repositories`);
      if (!got.ok) return got;
      repos.push(...got.value.map((r) => hosted(on, r.workspace.slug, r.slug, r.is_private)));
    }
  }
  return ok(repos.sort((a, b) => a.org.localeCompare(b.org) || a.name.localeCompare(b.name)));
}

/**
 * The repo's default branch and whether `yamlPath` (default `library.yaml`) is on `branch` (default: the
 * default branch). A repo the account can't see is NOT_FOUND: from outside, a missing repo and one
 * without access look the same.
 */
export async function checkCatalogRepo(
  ctx: HostApiCtx,
  req: { on: AccountHost; org: string; name: string; branch?: string; yamlPath?: string; signal?: AbortSignal },
): Promise<Result<CatalogRepo>> {
  const { on, org, name } = req;
  const api = await hostApi(ctx, on, req.signal);
  if (!api.ok) return api;
  const { bases } = api.value;
  const repoUrl = on === "github" ? `${bases.github}/repos/${org}/${name}` : `${bases.bitbucket}/repositories/${org}/${name}`;
  const info = await api.value.call({ method: "GET", url: repoUrl, headers: api.value.headers });
  if (!info.ok) return info;
  if (info.value.status === 404) {
    const hint = on === "github" ? " (an organization that restricts OAuth apps hides its repositories until an owner approves Loadout)" : "";
    return err({ code: "NOT_FOUND", message: `${HOST_LABELS[on]} shows no ${org}/${name} to this account: it doesn't exist, or the account can't read it${hint}` });
  }
  if (info.value.status !== 200) return api.value.failed(info.value, `reading ${org}/${name}`);
  const body = JSON.parse(info.value.body) as { default_branch?: string; mainbranch?: { name?: string } };
  const defaultBranch = (on === "github" ? body.default_branch : body.mainbranch?.name) ?? "main";
  const branch = req.branch ?? defaultBranch;
  const yamlPath = req.yamlPath ?? "library.yaml";
  const path = yamlPath.split("/").map(encodeURIComponent).join("/");
  const fileUrl =
    on === "github"
      ? `${repoUrl}/contents/${path}?ref=${encodeURIComponent(branch)}`
      : `${repoUrl}/src/${encodeURIComponent(branch)}/${path}`;
  const file = await api.value.call({ method: "GET", url: fileUrl, headers: api.value.headers });
  if (!file.ok) return file;
  if (file.value.status !== 200 && file.value.status !== 404) return api.value.failed(file.value, `looking for ${yamlPath}`);
  return ok({ defaultBranch, branch, yamlPath, found: file.value.status === 200 });
}
