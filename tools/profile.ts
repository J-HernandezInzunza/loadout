// Debug profiles (M16.09): a folder whose `home/` the app runs with as HOME. The app's `.claude`, app data,
// fs scope and Keychain all follow HOME (S17), so a profile needs no app change; it only needs its own
// login keychain, which `init` makes, with a random password kept beside it so `open` can unlock it.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const debugApp = join(repo, "apps/desktop/src-tauri/target/debug/loadout");

export function profileLayout(dir: string) {
  const root = resolve(dir);
  const home = join(root, "home");
  return { root, home, keychain: join(home, "Library/Keychains/login.keychain-db"), password: join(root, "keychain-password") };
}

/** `security`, run as the profile: with its HOME, so the keychain settings it writes are the profile's own. */
function security(home: string, args: string[]): void {
  execFileSync("security", args, { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "inherit"] });
}

/** Makes the profile's home and its login keychain; a profile already made is left as it is. */
export function initProfile(dir: string): ReturnType<typeof profileLayout> {
  const p = profileLayout(dir);
  mkdirSync(join(p.home, "Library/Keychains"), { recursive: true });
  if (!existsSync(p.keychain)) {
    const password = randomBytes(24).toString("hex");
    writeFileSync(p.password, password + "\n", { mode: 0o600 });
    security(p.home, ["create-keychain", "-p", password, p.keychain]);
    security(p.home, ["list-keychains", "-d", "user", "-s", p.keychain]);
    security(p.home, ["default-keychain", "-d", "user", "-s", p.keychain]);
    // No timeout: a demo can sit for a while without the keychain locking under it.
    security(p.home, ["set-keychain-settings", p.keychain]);
  }
  return p;
}

/** Unlocks the profile's keychain, which locks when the Mac does. */
export function unlockProfile(dir: string): void {
  const p = profileLayout(dir);
  security(p.home, ["unlock-keychain", "-p", readFileSync(p.password, "utf8").trim(), p.keychain]);
}

/** Runs the built debug app on the profile until it quits. */
function openProfile(dir: string): void {
  const p = profileLayout(dir);
  if (!existsSync(p.keychain)) throw new Error(`${p.root} is not a profile yet: run init first`);
  if (!existsSync(debugApp)) throw new Error(`no debug build at ${debugApp}: npm run tauri -w apps/desktop -- build --debug --no-bundle`);
  unlockProfile(dir);
  spawn(debugApp, [], { env: { ...process.env, HOME: p.home }, stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  if ((command !== "init" && command !== "open") || !dir) {
    console.error("usage: node tools/profile.ts init|open <dir>");
    process.exit(1);
  }
  if (command === "init") console.log(`profile ready: ${initProfile(dir).home}`);
  else openProfile(dir);
}
