// The GitHub token flows connect each fresh profile with (M16.11), kept in a keychain of their own by the
// `security` tool. Base64 on the wire, so the token's JSON needs no quoting; passed on stdin, never as an argument
// another process could read.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileLayout, unlockProfile } from "../../../tools/profile.ts";

/** A profile used only for its keychain. */
export const tokenProfile = fileURLToPath(new URL(".profiles/token", import.meta.url));
const service = "com.jhernandezinzunza.loadout.flows";

function security(stdin: string): string {
  const { home } = profileLayout(tokenProfile);
  return execFileSync("security", ["-i"], { input: stdin, encoding: "utf8", env: { ...process.env, HOME: home } });
}

export function storeFlowsToken(token: string): void {
  const { keychain } = profileLayout(tokenProfile);
  const value = Buffer.from(token).toString("base64");
  // Replaced, not updated: updating rewrites the item's access list, which asks for a prompt.
  try {
    security(`delete-generic-password -s ${service} -a github "${keychain}"\n`);
  } catch {
    // nothing stored yet
  }
  security(`add-generic-password -A -s ${service} -a github -w ${value} "${keychain}"\n`);
}

/** The stored token, as the app stores a GitHub token (JSON). */
export function flowsToken(): string {
  const { keychain } = profileLayout(tokenProfile);
  if (!existsSync(keychain)) throw new Error("flows have no GitHub token yet: run npm run flows:connect");
  unlockProfile(tokenProfile);
  const out = security(`find-generic-password -s ${service} -a github -w "${keychain}"\n`);
  const value = out.split("\n").map((l) => l.trim()).find((l) => /^[A-Za-z0-9+/]+=*$/.test(l) && l.length > 8);
  if (!value) throw new Error(`no flows token in ${join(keychain)}: run npm run flows:connect`);
  return Buffer.from(value, "base64").toString("utf8");
}
