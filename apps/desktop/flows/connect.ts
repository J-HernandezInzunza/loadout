// npm run flows:connect (M16.11): signs in to GitHub once, through the core's device flow and Loadout's own
// OAuth app, and keeps the token for flows (token.ts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary, type Host } from "@loadout/core";
import { initProfile, profileHost } from "./profile.ts";
import { storeFlowsToken, tokenFile } from "./token.ts";

const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
const clientId = existsSync(envFile) ? /^LOADOUT_GITHUB_CLIENT_ID=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim() : undefined;
if (!clientId) throw new Error(`no LOADOUT_GITHUB_CLIENT_ID in ${envFile}`);

// The sign-in records the account in a home of its own, thrown away afterwards; only the token is kept.
const scratch = mkdtempSync(join(tmpdir(), "loadout-flows-connect-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
initProfile(scratch);
const host = profileHost(scratch);
let token: string | undefined;
const capturing: Host = {
  ...host,
  secrets: {
    ...host.secrets,
    set: async (key, value) => {
      if (key === "github") token = value;
      return host.secrets.set(key, value);
    },
  },
};
const library = createLibrary(capturing, { githubClientId: clientId });
const begun = await library.beginSignIn("github");
if (!begun.ok) throw new Error(begun.error.message);
if (begun.value.on !== "github") throw new Error("expected GitHub's device flow");
console.log(`Enter ${begun.value.userCode} at ${begun.value.verificationUri} (opening it in your browser)…`);
execFileSync("open", [begun.value.verificationUri]);
const done = await library.completeSignIn(begun.value);
if (!done.ok) throw new Error(done.error.message);
if (!token) throw new Error("signed in, but no token was stored");
storeFlowsToken(token);
console.log(`Connected as ${done.value.login}; flows will use this token (kept in ${tokenFile}).`);
