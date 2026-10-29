// A local stand-in for the GitHub and Bitbucket endpoints Loadout calls (architecture.md §6): current
// user, GitHub's device flow, Bitbucket token refresh, PR create and list, and the repositories an
// account can read with their default branch and files. It records every request and can be told to
// fail. Response shapes follow the hosts' docs; Bitbucket's duplicate-PR answer is not documented,
// so it is a plain 400 here and M3.01 finds the existing PR by listing, not by parsing that error.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import type { ApiBases } from "../src/accounts/apiBases.ts";

export type Api = keyof ApiBases;

export interface RecordedRequest {
  api: Api;
  method: string;
  /** relative to the api's base, query included */
  path: string;
  /** names lowercased */
  headers: Record<string, string>;
  body: string;
}

export interface StubPull {
  number: number;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  open: boolean;
}

export interface StubRepo {
  /** GitHub owner or Bitbucket workspace */
  org: string;
  name: string;
  defaultBranch: string;
  private?: boolean;
  /** logins that can read it, owners or not */
  readers: string[];
  /** paths present on each branch */
  files: Record<string, string[]>;
}

export interface ApiStub {
  bases: ApiBases;
  requests: RecordedRequest[];
  /** a token the api accepts as `Bearer <token>`, answering for `login` */
  addToken(api: "github" | "bitbucket", token: string, login: string, scopes?: string[]): void;
  /** the token now answers 401 as an expired one */
  expireToken(token: string): void;
  /** a Bitbucket refresh token; each refresh mints a fresh access token for `login` */
  addRefreshToken(refresh: string, login: string): void;
  pulls(api: "github" | "bitbucket"): StubPull[];
  /** Bitbucket: an authorization code, as its consent page would redirect with, that exchanges for `login`'s tokens */
  addAuthCode(code: string, login: string): void;
  /** GitHub device flow: the user approves `userCode` as `login`, which mints a token with `scopes` */
  approveDevice(userCode: string, login: string, scopes?: string[]): void;
  /** GitHub device flow: the user declines `userCode` */
  denyDevice(userCode: string): void;
  /** GitHub device flow: `userCode` lapses, as after its 15 minutes */
  expireDevice(userCode: string): void;
  /** GitHub device flow: the next poll of `userCode` is told to slow down */
  slowDownDevice(userCode: string): void;
  addRepo(api: "github" | "bitbucket", repo: StubRepo): void;
  /** list pages hold this many items, whatever the request asks for, so paging can be tested */
  setPageSize(size: number): void;
  /** The next request matching `match` gets this answer instead of the normal one. */
  failNext(match: { api: Api; method?: string; path?: string }, status: number, body?: unknown): void;
}

interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const githubDocs = "https://docs.github.com/rest";

export async function createApiStub(): Promise<ApiStub> {
  const requests: RecordedRequest[] = [];
  const tokens = new Map<string, { api: Api; login: string; scopes: string[]; expired: boolean }>();
  const refreshTokens = new Map<string, string>();
  const authCodes = new Map<string, string>();
  const pulls: Record<"github" | "bitbucket", StubPull[]> = { github: [], bitbucket: [] };
  const repos: Record<"github" | "bitbucket", StubRepo[]> = { github: [], bitbucket: [] };
  let pageSize: number | null = null;
  let origin = "";
  const page = <T>(all: T[], asked: number, n: number) => {
    const size = pageSize ?? asked;
    return { items: all.slice((n - 1) * size, n * size), more: n * size < all.length };
  };
  const readable = (api: "github" | "bitbucket", login: string) => repos[api].filter((r) => r.readers.includes(login));
  const findRepo = (api: "github" | "bitbucket", login: string, full: string) => readable(api, login).find((r) => `${r.org}/${r.name}` === full);
  const failures: { match: { api: Api; method?: string; path?: string }; answer: Answer }[] = [];
  type Device = { userCode: string; state: "pending" | "slow" | "denied" | "expired" | { login: string; scopes: string[] } };
  const devices = new Map<string, Device>();
  const deviceOf = (userCode: string) => [...devices.values()].find((d) => d.userCode === userCode)!;
  let minted = 0;

  const bearer = (api: Api, r: RecordedRequest) => {
    const token = /^Bearer (.+)$/.exec(r.headers.authorization ?? "")?.[1];
    const found = token === undefined ? undefined : tokens.get(token);
    return found?.api === api ? found : undefined;
  };

  const githubUnauthorized: Answer = {
    status: 401,
    body: { message: "Bad credentials", documentation_url: githubDocs, status: "401" },
  };
  const bitbucketError = (status: number, message: string): Answer => ({
    status,
    body: { type: "error", error: { message } },
  });

  function github(r: RecordedRequest): Answer {
    const auth = bearer("github", r);
    if (!auth || auth.expired) return githubUnauthorized;
    const url = new URL(r.path, "http://x");
    if (r.method === "GET" && url.pathname === "/user") {
      return { status: 200, body: { login: auth.login, id: 1 }, headers: { "x-oauth-scopes": auth.scopes.join(", ") } };
    }
    const notFound: Answer = { status: 404, body: { message: "Not Found", documentation_url: githubDocs, status: "404" } };
    if (r.method === "GET" && url.pathname === "/user/repos") {
      const n = Number(url.searchParams.get("page") ?? "1");
      const { items, more } = page(readable("github", auth.login), Number(url.searchParams.get("per_page") ?? "30"), n);
      const next = new URL(`${origin}/github${url.pathname}`);
      url.searchParams.forEach((v, k) => next.searchParams.set(k, v));
      next.searchParams.set("page", String(n + 1));
      return {
        status: 200,
        body: items.map((x) => ({ name: x.name, full_name: `${x.org}/${x.name}`, owner: { login: x.org }, private: !!x.private, default_branch: x.defaultBranch })),
        ...(more && { headers: { link: `<${next.toString()}>; rel="next"` } }),
      };
    }
    const contents = /^\/repos\/([^/]+\/[^/]+)(?:\/contents\/(.+))?$/.exec(url.pathname);
    if (r.method === "GET" && contents) {
      const found = findRepo("github", auth.login, contents[1]!);
      if (!found) return notFound;
      if (contents[2] === undefined) return { status: 200, body: { full_name: contents[1], default_branch: found.defaultBranch, private: !!found.private } };
      const ref = url.searchParams.get("ref") ?? found.defaultBranch;
      const path = decodeURIComponent(contents[2]);
      return found.files[ref]?.includes(path) ? { status: 200, body: { type: "file", path, content: "" } } : notFound;
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname);
    if (!m) return { status: 404, body: { message: "Not Found", documentation_url: githubDocs, status: "404" } };
    const repo = m[1]!;
    const owner = repo.split("/")[0]!;
    const view = (p: StubPull) => ({
      number: p.number,
      html_url: `https://github.com/${repo}/pull/${p.number}`,
      state: p.open ? "open" : "closed",
      title: p.title,
      body: p.body,
      head: { ref: p.head, label: `${owner}:${p.head}` },
      base: { ref: p.base },
    });
    const ofRepo = pulls.github.filter((p) => p.repo === repo);
    if (r.method === "GET") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      const listed = ofRepo.filter(
        (p) => (head === null || `${owner}:${p.head}` === head) && (state === "all" || p.open === (state === "open")),
      );
      return { status: 200, body: listed.map(view) };
    }
    if (r.method !== "POST") return { status: 404, body: { message: "Not Found" } };
    const req = JSON.parse(r.body) as { title: string; head: string; base: string; body?: string };
    if (ofRepo.some((p) => p.open && p.head === req.head && p.base === req.base)) {
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            { resource: "PullRequest", code: "custom", message: `A pull request already exists for ${owner}:${req.head}.` },
          ],
          documentation_url: `${githubDocs}/pulls/pulls#create-a-pull-request`,
          status: "422",
        },
      };
    }
    const pull = { number: pulls.github.length + 1, repo, ...req, body: req.body ?? "", open: true };
    pulls.github.push(pull);
    return { status: 201, body: view(pull) };
  }

  function bitbucket(r: RecordedRequest): Answer {
    const auth = bearer("bitbucket", r);
    if (!auth) return bitbucketError(401, "Token is invalid or not supported for this endpoint.");
    if (auth.expired) return bitbucketError(401, "Access token expired.");
    const url = new URL(r.path, "http://x");
    if (r.method === "GET" && url.pathname === "/user") {
      return { status: 200, body: { username: auth.login, display_name: auth.login, uuid: `{${auth.login}}` } };
    }
    // Absolute, as Bitbucket's own `next` links are.
    const paged = <T>(all: T[], path: string) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      const pagelen = Number(url.searchParams.get("pagelen") ?? "10");
      const { items, more } = page(all, pagelen, n);
      const next = new URL(`${origin}/bitbucket${path}`);
      url.searchParams.forEach((v, k) => next.searchParams.set(k, v));
      next.searchParams.set("page", String(n + 1));
      return { status: 200, body: { values: items, page: n, pagelen, size: all.length, ...(more && { next: next.toString() }) } };
    };
    if (r.method === "GET" && url.pathname === "/user/workspaces") {
      const slugs = [...new Set(readable("bitbucket", auth.login).map((x) => x.org))].sort();
      return paged(slugs.map((slug) => ({ type: "workspace_access", administrator: false, workspace: { slug, type: "workspace_base" } })), url.pathname);
    }
    const inWorkspace = /^\/repositories\/([^/]+)$/.exec(url.pathname);
    if (r.method === "GET" && inWorkspace) {
      if (url.searchParams.get("role") !== "member") return bitbucketError(400, "the stub lists by role=member only");
      const listed = readable("bitbucket", auth.login).filter((x) => x.org === decodeURIComponent(inWorkspace[1]!));
      return paged(listed.map((x) => ({ slug: x.name, full_name: `${x.org}/${x.name}`, is_private: !!x.private, workspace: { slug: x.org } })), url.pathname);
    }
    const src = /^\/repositories\/([^/]+\/[^/]+)(?:\/src\/([^/]+)\/(.+))?$/.exec(url.pathname);
    if (r.method === "GET" && src) {
      const found = findRepo("bitbucket", auth.login, src[1]!);
      if (!found) return bitbucketError(404, "Repository not found");
      if (src[2] === undefined) return { status: 200, body: { full_name: src[1], is_private: !!found.private, mainbranch: { type: "branch", name: found.defaultBranch } } };
      const path = decodeURIComponent(src[3]!);
      return found.files[decodeURIComponent(src[2])]?.includes(path) ? { status: 200, body: "" } : bitbucketError(404, "No such file or directory");
    }
    const m = /^\/repositories\/([^/]+\/[^/]+)\/pullrequests$/.exec(url.pathname);
    if (!m) return bitbucketError(404, "Resource not found");
    const repo = m[1]!;
    const view = (p: StubPull) => ({
      id: p.number,
      title: p.title,
      description: p.body,
      state: p.open ? "OPEN" : "MERGED",
      source: { branch: { name: p.head } },
      destination: { branch: { name: p.base } },
      links: { html: { href: `https://bitbucket.org/${repo}/pull-requests/${p.number}` } },
    });
    const ofRepo = pulls.bitbucket.filter((p) => p.repo === repo);
    if (r.method === "GET") {
      const filter = bitbucketQuery(url.searchParams.get("q"));
      if (!filter) return bitbucketError(400, "Invalid query (the stub knows source.branch.name and state only)");
      const listed = ofRepo.filter(
        (p) =>
          (filter.branch === undefined || p.head === filter.branch) &&
          (filter.state === undefined || (filter.state === "OPEN") === p.open),
      );
      return { status: 200, body: { values: listed.map(view), pagelen: 10, size: listed.length, page: 1 } };
    }
    if (r.method !== "POST") return bitbucketError(404, "Resource not found");
    const req = JSON.parse(r.body) as {
      title: string;
      description?: string;
      source: { branch: { name: string } };
      destination: { branch: { name: string } };
    };
    const head = req.source.branch.name;
    const base = req.destination.branch.name;
    if (ofRepo.some((p) => p.open && p.head === head && p.base === base)) {
      return bitbucketError(400, `There is already an open pull request from ${head} to ${base}.`);
    }
    const pull = { number: pulls.bitbucket.length + 1, repo, head, base, title: req.title, body: req.description ?? "", open: true };
    pulls.bitbucket.push(pull);
    return { status: 201, body: view(pull) };
  }

  function bitbucketAuth(r: RecordedRequest): Answer {
    if (r.method !== "POST" || r.path !== "/access_token") return { status: 404, body: { error: "not_found" } };
    if (!/^Basic /.test(r.headers.authorization ?? "")) {
      return { status: 401, body: { error: "invalid_client", error_description: "Client credentials missing" } };
    }
    const form = new URLSearchParams(r.body);
    const grant = form.get("grant_type");
    let login: string | undefined;
    let refresh = form.get("refresh_token");
    if (grant === "refresh_token") {
      login = refreshTokens.get(refresh ?? "");
    } else if (grant === "authorization_code") {
      // Single use, as Bitbucket's codes are.
      login = authCodes.get(form.get("code") ?? "");
      authCodes.delete(form.get("code") ?? "");
      refresh = `bb-refresh-${minted + 1}`;
      if (login !== undefined) refreshTokens.set(refresh, login);
    }
    if (login === undefined) {
      return { status: 400, body: { error: "invalid_grant", error_description: `Invalid ${grant === "authorization_code" ? "code" : "refresh_token"}` } };
    }
    const access = `bb-access-${++minted}`;
    tokens.set(access, { api: "bitbucket", login, scopes: [], expired: false });
    return {
      status: 200,
      body: {
        access_token: access,
        refresh_token: refresh,
        expires_in: 7200,
        token_type: "bearer",
        scopes: "account repository:write pullrequest:write",
      },
    };
  }

  // GitHub answers device-flow polls with 200 and an `error` until the user decides; interval 0 keeps tests fast.
  function githubLogin(r: RecordedRequest): Answer {
    const form = new URLSearchParams(r.body);
    if (r.method === "POST" && r.path === "/login/device/code") {
      if (form.get("client_id") !== "gh-client") return { status: 200, body: { error: "incorrect_client_credentials" } };
      const n = devices.size + 1;
      devices.set(`device-${n}`, { userCode: `CODE-000${n}`, state: "pending" });
      return {
        status: 200,
        body: { device_code: `device-${n}`, user_code: `CODE-000${n}`, verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 },
      };
    }
    if (r.method === "POST" && r.path === "/login/oauth/access_token") {
      const device = devices.get(form.get("device_code") ?? "");
      if (device === undefined) return { status: 200, body: { error: "incorrect_device_code" } };
      if (device.state === "pending") return { status: 200, body: { error: "authorization_pending" } };
      if (device.state === "slow") {
        device.state = "pending";
        return { status: 200, body: { error: "slow_down", interval: 0 } };
      }
      if (device.state === "denied") return { status: 200, body: { error: "access_denied" } };
      if (device.state === "expired") return { status: 200, body: { error: "expired_token" } };
      const access = `gh-access-${++minted}`;
      tokens.set(access, { api: "github", login: device.state.login, scopes: device.state.scopes, expired: false });
      return { status: 200, body: { access_token: access, token_type: "bearer", scope: device.state.scopes.join(",") } };
    }
    return { status: 404, body: { error: "not_found" } };
  }

  const handlers: Record<Api, (r: RecordedRequest) => Answer> = { github, githubLogin, bitbucket, bitbucketAuth };

  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const [, api, path = "/"] = /^\/(githubLogin|github|bitbucketAuth|bitbucket)(\/.*)?$/.exec(req.url ?? "") ?? [];
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
      );
      if (api === undefined) {
        res.writeHead(404).end();
        return;
      }
      const recorded: RecordedRequest = { api: api as Api, method: req.method ?? "GET", path, headers, body };
      requests.push(recorded);
      const failure = failures.findIndex(
        ({ match }) =>
          match.api === recorded.api &&
          (match.method === undefined || match.method === recorded.method) &&
          (match.path === undefined || match.path === recorded.path),
      );
      const answer = failure >= 0 ? failures.splice(failure, 1)[0]!.answer : handlers[recorded.api](recorded);
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    bases: {
      github: `${origin}/github`,
      githubLogin: `${origin}/githubLogin`,
      bitbucket: `${origin}/bitbucket`,
      bitbucketAuth: `${origin}/bitbucketAuth`,
    },
    requests,
    addToken(api, token, login, scopes = []) {
      tokens.set(token, { api, login, scopes, expired: false });
    },
    expireToken(token) {
      const t = tokens.get(token);
      if (t) t.expired = true;
    },
    addRefreshToken(refresh, login) {
      refreshTokens.set(refresh, login);
    },
    addAuthCode(code, login) {
      authCodes.set(code, login);
    },
    pulls: (api) => pulls[api],
    approveDevice(userCode, login, scopes = ["repo"]) {
      deviceOf(userCode).state = { login, scopes };
    },
    denyDevice(userCode) {
      deviceOf(userCode).state = "denied";
    },
    expireDevice(userCode) {
      deviceOf(userCode).state = "expired";
    },
    slowDownDevice(userCode) {
      deviceOf(userCode).state = "slow";
    },
    addRepo(api, repo) {
      repos[api].push(repo);
    },
    setPageSize(size) {
      pageSize = size;
    },
    failNext(match, status, body) {
      failures.push({ match, answer: { status, body } });
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8").on("data", (d: string) => (body += d));
    req.on("end", () => resolve(body));
  });
}

/** `source.branch.name="x" AND state="OPEN"`, either clause optional; null for anything else. */
function bitbucketQuery(q: string | null): { branch?: string; state?: string } | null {
  if (q === null) return {};
  const out: { branch?: string; state?: string } = {};
  for (const clause of q.split(/\s+AND\s+/)) {
    const m = /^(source\.branch\.name|state)\s*=\s*"([^"]*)"$/.exec(clause.trim());
    if (!m) return null;
    if (m[1] === "state") out.state = m[2]!;
    else out.branch = m[2]!;
  }
  return out;
}
