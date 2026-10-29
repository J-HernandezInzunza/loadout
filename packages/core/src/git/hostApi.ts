// An authenticated call to a host's REST API with the connected account's token (architecture.md §5.5),
// shared by the pull-request client and the repository lookups. Failures are typed, never thrown.
import { defaultApiBases, type ApiBases } from "../accounts/apiBases.ts";
import type { AccountHost, Accounts } from "../accounts/accounts.ts";
import type { Host, HttpRequest, HttpResponse } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";

export interface HostApiCtx {
  host: Host;
  accounts: Pick<Accounts, "tokenFor">;
  apiBases?: ApiBases;
}

export const HOST_LABELS: Record<AccountHost, string> = { github: "GitHub", bitbucket: "Bitbucket" };
// The version the GitHub REST docs pin in their examples.
export const githubHeaders = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };

const timeoutMs = 30_000;

export interface HostApi {
  bases: ApiBases;
  /** the account's Authorization header, plus GitHub's version headers on GitHub */
  headers: Record<string, string>;
  call(r: HttpRequest): Promise<Result<HttpResponse>>;
  /** a non-success answer: AUTH_FAILED for a refused token, API_FAILED with the host's own text otherwise */
  failed(res: HttpResponse, what: string): Result<never>;
}

/** NOT_CONNECTED (from tokenFor) when the host has no account. */
export async function hostApi(ctx: HostApiCtx, on: AccountHost, signal?: AbortSignal): Promise<Result<HostApi>> {
  const token = await ctx.accounts.tokenFor(on);
  if (!token.ok) return token;
  const label = HOST_LABELS[on];
  return ok({
    bases: ctx.apiBases ?? defaultApiBases,
    headers: { Authorization: `Bearer ${token.value}`, ...(on === "github" && githubHeaders) },
    async call(r) {
      try {
        return ok(await ctx.host.http.request({ timeoutMs, ...(signal && { signal }), ...r }));
      } catch (e) {
        if (signal?.aborted) return err({ code: "CANCELLED", message: `${label}: cancelled` });
        return err({ code: "API_FAILED", message: `${label}: ${(e as Error).message}` });
      }
    },
    failed(res, what) {
      if (res.status === 401 || res.status === 403) {
        return err({ code: "AUTH_FAILED", message: `${label} refused the account's token (HTTP ${res.status}); connect it again` });
      }
      return err({ code: "API_FAILED", message: `${label} answered HTTP ${res.status} to ${what}: ${apiMessage(res.body)}` });
    },
  });
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
