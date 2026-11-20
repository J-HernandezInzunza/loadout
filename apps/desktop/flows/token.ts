// The GitHub token flows connect each fresh profile with (M16.11): an owner-only file, git-ignored, that
// `npm run flows:connect` fills once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const tokenFile = fileURLToPath(new URL(".profiles/github-token.json", import.meta.url));

export function storeFlowsToken(token: string): void {
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token, { mode: 0o600 });
}

/** The stored token, as the app stores a GitHub token (JSON). */
export function flowsToken(): string {
  if (!existsSync(tokenFile)) throw new Error("flows have no GitHub token yet: run npm run flows:connect");
  return readFileSync(tokenFile, "utf8");
}
