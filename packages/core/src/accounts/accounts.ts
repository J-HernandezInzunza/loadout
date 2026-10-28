// Connected GitHub and Bitbucket accounts (architecture.md §5.5). Tokens live only in Host.secrets,
// one JSON token set per host; config.json keeps the login, scopes and connection time. The OAuth
// sign-in flows (M4) end by calling connect().
import { z } from "zod";
import type { AccountInfo, ConfigStore } from "../config/config.ts";
import type { Host } from "../host.ts";
import { err, ok, type Result } from "../model/model.ts";
import { defaultApiBases, type ApiBases } from "./apiBases.ts";

export type AccountHost = "github" | "bitbucket";

export const TokenSet = z.strictObject({
  accessToken: z.string(),
  refreshToken: z.string().exactOptional(),
  /** ISO time; Bitbucket access tokens last two hours */
  expiresAt: z.string().exactOptional(),
  /** as granted, when the token response says (Bitbucket's `scopes`) */
  scopes: z.array(z.string()).exactOptional(),
});
export type TokenSet = z.infer<typeof TokenSet>;

export interface AccountsOptions {
  apiBases?: ApiBases;
  /** the Bitbucket OAuth consumer, injected into release builds; needed to refresh tokens */
  bitbucketClient?: { id: string; secret: string };
}

export interface Accounts {
  /** Validates the token (whoami), then stores it. */
  connect(on: AccountHost, tokens: TokenSet): Promise<Result<AccountInfo>>;
  /** Deletes the token and the account's facts; succeeds when nothing was connected. */
  disconnect(on: AccountHost): Promise<Result<void>>;
  accounts(): Promise<Result<Partial<Record<AccountHost, AccountInfo>>>>;
  /** The access token to use now, refreshing an expired Bitbucket token first. */
  tokenFor(on: AccountHost): Promise<Result<string>>;
  /** The login and scopes a token belongs to; AUTH_FAILED when the host rejects it. */
  whoami(on: AccountHost, accessToken: string): Promise<Result<{ login: string; scopes: string[] | null }>>;
}

const names: Record<AccountHost, string> = { github: "GitHub", bitbucket: "Bitbucket" };
// Refresh a little early, so a token does not expire between tokenFor() and its use.
const refreshMarginMs = 60_000;
const timeoutMs = 15_000;

export function createAccounts(host: Host, store: ConfigStore, opts: AccountsOptions = {}): Accounts {
  const bases = opts.apiBases ?? defaultApiBases;

  async function request(req: Parameters<Host["http"]["request"]>[0]) {
    try {
      return ok(await host.http.request({ timeoutMs, ...req }));
    } catch (e) {
      return err({ code: "API_FAILED", message: `${new URL(req.url).host}: ${(e as Error).message}` });
    }
  }

  async function whoami(on: AccountHost, accessToken: string): ReturnType<Accounts["whoami"]> {
    const res = await request(
      on === "github"
        ? {
            method: "GET",
            url: `${bases.github}/user`,
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
          }
        : { method: "GET", url: `${bases.bitbucket}/user`, headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return res;
    const { status, headers, body } = res.value;
    if (status === 401 || status === 403) {
      return err({ code: "AUTH_FAILED", message: `${names[on]} rejected the token (HTTP ${status}); connect the account again` });
    }
    if (status !== 200) return err({ code: "API_FAILED", message: `${names[on]} answered HTTP ${status} to the user lookup` });
    const user = JSON.parse(body) as { login?: string; username?: string };
    const login = on === "github" ? user.login : user.username;
    if (typeof login !== "string") return err({ code: "API_FAILED", message: `${names[on]}'s user lookup had no login` });
    const scopes = headers["x-oauth-scopes"];
    return ok({ login, scopes: scopes === undefined ? null : scopes.split(",").map((s) => s.trim()).filter(Boolean) });
  }

  async function readTokens(on: AccountHost): Promise<TokenSet | null> {
    const raw = await host.secrets.get(on);
    if (raw === null) return null;
    try {
      return TokenSet.parse(JSON.parse(raw));
    } catch {
      return null; // unreadable: treated as not connected, so the user reconnects
    }
  }

  async function refreshBitbucket(tokens: TokenSet): Promise<Result<TokenSet>> {
    const reconnect = (why: string) => err({ code: "AUTH_FAILED" as const, message: `Bitbucket token expired and ${why}; connect the account again` });
    if (tokens.refreshToken === undefined) return reconnect("there is no refresh token");
    if (opts.bitbucketClient === undefined) return reconnect("this build has no Bitbucket client to refresh it with");
    const { id, secret } = opts.bitbucketClient;
    const res = await request({
      method: "POST",
      url: `${bases.bitbucketAuth}/access_token`,
      headers: {
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }).toString(),
    });
    if (!res.ok) return res;
    if (res.value.status !== 200) return reconnect(`the refresh was refused (HTTP ${res.value.status})`);
    const answer = JSON.parse(res.value.body) as { access_token: string; refresh_token?: string; expires_in: number; scopes?: string };
    const next: TokenSet = {
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token ?? tokens.refreshToken,
      expiresAt: new Date(host.now().getTime() + answer.expires_in * 1000).toISOString(),
      ...(answer.scopes !== undefined ? { scopes: answer.scopes.split(" ") } : tokens.scopes && { scopes: tokens.scopes }),
    };
    await host.secrets.set("bitbucket", JSON.stringify(next));
    return ok(next);
  }

  return {
    whoami,

    async connect(on, tokens) {
      const who = await whoami(on, tokens.accessToken);
      if (!who.ok) return who;
      const info: AccountInfo = {
        login: who.value.login,
        scopes: who.value.scopes ?? tokens.scopes ?? [],
        connectedAt: host.now().toISOString(),
      };
      await host.secrets.set(on, JSON.stringify(TokenSet.parse(tokens)));
      const saved = await store.updateConfig((c) => ({ ...c, accounts: { ...c.accounts, [on]: info } }));
      if (saved.ok) return ok(info);
      await host.secrets.delete(on);
      return saved;
    },

    async disconnect(on) {
      await host.secrets.delete(on);
      const saved = await store.updateConfig((c) => {
        if (c.accounts?.[on] === undefined) return c;
        const accounts = { ...c.accounts };
        delete accounts[on];
        return { ...c, accounts };
      });
      return saved.ok ? ok(undefined) : saved;
    },

    async accounts() {
      const loaded = await store.loadConfig();
      return loaded.ok ? ok(loaded.value.config.accounts ?? {}) : loaded;
    },

    async tokenFor(on) {
      const tokens = await readTokens(on);
      if (tokens === null) return err({ code: "NOT_CONNECTED", message: `No ${names[on]} account is connected` });
      const expired =
        tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) - refreshMarginMs <= host.now().getTime();
      if (!expired) return ok(tokens.accessToken);
      if (on === "github") return err({ code: "AUTH_FAILED", message: "GitHub token expired; connect the account again" });
      const refreshed = await refreshBitbucket(tokens);
      return refreshed.ok ? ok(refreshed.value.accessToken) : refreshed;
    },
  };
}
