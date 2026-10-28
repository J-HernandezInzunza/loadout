// Opening a pull request through the host's REST API (architecture.md §5.5, WRITE-11 rebuild). A PR
// for the same branch that already exists is success with that PR's URL (Q2): the create answers
// 422 (GitHub) or 400 (Bitbucket, whose exact wording is undocumented), so instead of parsing it the
// client looks for an open PR from the head branch and returns that.
import { defaultApiBases, type ApiBases } from "../accounts/apiBases.ts";
import type { AccountHost, Accounts } from "../accounts/accounts.ts";
import type { Host, HttpRequest, HttpResponse } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";

export interface PullRequestCtx {
  host: Host;
  accounts: Pick<Accounts, "tokenFor">;
  apiBases?: ApiBases;
}

export interface PullRequestRepo {
  kind: AccountHost;
  /** GitHub owner or Bitbucket workspace */
  org: string;
  repo: string;
}

export interface PullRequest {
  url: string;
  number: number;
  /** true when the PR already existed and was returned instead of created */
  existing: boolean;
}

const timeoutMs = 30_000;
const names: Record<AccountHost, string> = { github: "GitHub", bitbucket: "Bitbucket" };
// The version the GitHub REST docs pin in their examples.
const githubHeaders = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };

type GithubPull = { number: number; html_url: string };
type BitbucketPull = { id: number; links: { html: { href: string } } };

export async function createPullRequest(
  ctx: PullRequestCtx,
  repo: PullRequestRepo,
  req: { base: string; head: string; title: string; body: string },
): Promise<Result<PullRequest>> {
  const bases = ctx.apiBases ?? defaultApiBases;
  const token = await ctx.accounts.tokenFor(repo.kind);
  if (!token.ok) return token;
  const auth = { Authorization: `Bearer ${token.value}` };
  const label = names[repo.kind];

  const call = async (r: HttpRequest): Promise<Result<HttpResponse>> => {
    try {
      return ok(await ctx.host.http.request({ timeoutMs, ...r }));
    } catch (e) {
      return err({ code: "API_FAILED", message: `${label}: ${(e as Error).message}` });
    }
  };
  const failed = (res: HttpResponse, what: string) =>
    res.status === 401 || res.status === 403
      ? err({ code: "AUTH_FAILED" as const, message: `${label} refused the account's token (HTTP ${res.status}); connect it again` })
      : err({ code: "API_FAILED" as const, message: `${label} answered HTTP ${res.status} to ${what}: ${apiMessage(res.body)}` });

  if (repo.kind === "github") {
    const pulls = `${bases.github}/repos/${repo.org}/${repo.repo}/pulls`;
    const headers = { ...auth, ...githubHeaders };
    const created = await call({
      method: "POST",
      url: pulls,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: req.title, head: req.head, base: req.base, body: req.body }),
    });
    if (!created.ok) return created;
    if (created.value.status === 201) {
      const pr = JSON.parse(created.value.body) as GithubPull;
      return ok({ url: pr.html_url, number: pr.number, existing: false });
    }
    if (created.value.status !== 422) return failed(created.value, "creating the pull request");
    const listed = await call({
      method: "GET",
      url: `${pulls}?state=open&head=${encodeURIComponent(`${repo.org}:${req.head}`)}&base=${encodeURIComponent(req.base)}`,
      headers,
    });
    if (!listed.ok) return listed;
    const [existing] = listed.value.status === 200 ? (JSON.parse(listed.value.body) as GithubPull[]) : [];
    return existing ? ok({ url: existing.html_url, number: existing.number, existing: true }) : failed(created.value, "creating the pull request");
  }

  const pulls = `${bases.bitbucket}/repositories/${repo.org}/${repo.repo}/pullrequests`;
  const created = await call({
    method: "POST",
    url: pulls,
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: req.title,
      description: req.body,
      source: { branch: { name: req.head } },
      destination: { branch: { name: req.base } },
    }),
  });
  if (!created.ok) return created;
  if (created.value.status === 201) {
    const pr = JSON.parse(created.value.body) as BitbucketPull;
    return ok({ url: pr.links.html.href, number: pr.id, existing: false });
  }
  if (created.value.status !== 400 && created.value.status !== 409) return failed(created.value, "creating the pull request");
  const q = `source.branch.name="${req.head}" AND state="OPEN"`;
  const listed = await call({ method: "GET", url: `${pulls}?q=${encodeURIComponent(q)}`, headers: auth });
  if (!listed.ok) return listed;
  const values = listed.value.status === 200 ? (JSON.parse(listed.value.body) as { values: (BitbucketPull & { destination?: { branch?: { name?: string } } })[] }).values : [];
  const existing = values.find((p) => p.destination?.branch?.name === undefined || p.destination.branch.name === req.base);
  return existing ? ok({ url: existing.links.html.href, number: existing.id, existing: true }) : failed(created.value, "creating the pull request");
}

/** The host's own error text, when the body carries one. */
function apiMessage(body: string): string {
  try {
    const data = JSON.parse(body) as { message?: unknown; error?: { message?: unknown } | string };
    if (typeof data.message === "string") return data.message;
    if (typeof data.error === "object" && typeof data.error?.message === "string") return data.error.message;
    if (typeof data.error === "string") return data.error;
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || "no details";
}
