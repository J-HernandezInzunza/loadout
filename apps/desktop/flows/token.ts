// The GitHub token flows connect each fresh profile with (M16.11): an owner-only file that `npm run flows:connect`
// fills once. Outside the repo, so cleaning or removing a worktree doesn't lose it and the tree never holds it.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const tokenFile = join(homedir(), "Library/Application Support/loadout-dev/flows-github-token.json");

export function storeFlowsToken(token: string): void {
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, token, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
}

/** The stored token, as the app stores a GitHub token (JSON). */
export function flowsToken(): string {
  if (!existsSync(tokenFile)) throw new Error("flows have no GitHub token yet: run npm run flows:connect");
  return readFileSync(tokenFile, "utf8");
}
