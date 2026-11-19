// Debug profiles (M16.09, M16.10): a folder whose `home/` the app runs with as HOME. The app's `.claude`, app
// data, fs scope and Keychain all follow HOME (S17), so a profile needs no app change; it only needs its own
// login keychain, which `init` makes, with a random password kept beside it so `open` can unlock it. `demo`
// (npm run app:profile -- <dir>) builds the debug app, makes and seeds a new profile, and opens it.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeHost } from "@loadout/host-node";
import { seedDemo } from "@loadout/sandbox";

const repo = fileURLToPath(new URL("..", import.meta.url));
const debugApp = join(repo, "apps/desktop/src-tauri/target/debug/loadout");
const identifier = (JSON.parse(readFileSync(join(repo, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")) as { identifier: string }).identifier;

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

/**
 * Fills a new profile with the demo machine (M16.10), through the core over the profile's home and app data
 * as the app finds them. Git runs with the real user's credentials, which the seed's push to the demo repo
 * needs; the profile's home gets its own git identity, for the commits the app makes there.
 */
export async function seedProfile(dir: string): Promise<void> {
  const p = profileLayout(dir);
  writeFileSync(join(p.home, ".gitconfig"), "[user]\n\tname = Loadout Demo\n\temail = demo@loadout.invalid\n");
  await seedDemo(createNodeHost({ home: p.home, appData: join(p.home, "Library/Application Support", identifier) }));
}

/**
 * The environment the app starts with: what launchd gives a Finder launch, with the profile's HOME. Nothing
 * else from the calling shell, so a variable such as CLAUDE_CONFIG_DIR can't point the app back at the real
 * user's files; the app repairs PATH from the profile's login shell, as it does when launched from Finder.
 */
export function profileEnv(home: string, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = ["USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "__CF_USER_TEXT_ENCODING"].flatMap((k) => (from[k] ? [[k, from[k]]] : []));
  return { ...Object.fromEntries(kept), HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
}

/** Runs the built debug app on the profile until it quits. */
function openProfile(dir: string): void {
  const p = profileLayout(dir);
  if (!existsSync(p.keychain)) throw new Error(`${p.root} is not a profile yet: run init first`);
  if (!existsSync(debugApp)) throw new Error(`no debug build at ${debugApp}: npm run tauri -w apps/desktop -- build --debug --no-bundle`);
  unlockProfile(dir);
  // The app caches what the login shell reported; probing afresh keeps that the profile's own.
  rmSync(join(p.home, "Library/Application Support", identifier, "shell-env.json"), { force: true });
  spawn(debugApp, [], { env: profileEnv(p.home), stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  // npm runs scripts from the repo root; a relative folder means the one the command was typed in.
  const dir = arg && resolve(process.env.INIT_CWD ?? ".", arg);
  if (!["init", "open", "demo"].includes(command ?? "") || !dir) {
    console.error("usage: node tools/profile.ts init|open|demo <dir>   (demo: build, make and seed when new, open)");
    process.exit(1);
  }
  if (command === "init") console.log(`profile ready: ${initProfile(dir).home}`);
  if (command === "demo") {
    execFileSync("npm", ["run", "tauri", "-w", "apps/desktop", "--", "build", "--debug", "--no-bundle"], { cwd: repo, stdio: "inherit" });
    if (!existsSync(profileLayout(dir).keychain)) {
      const made = !existsSync(dir);
      initProfile(dir);
      try {
        await seedProfile(dir);
      } catch (e) {
        // Half-seeded, the next run would take it for a profile: remove what this run made.
        if (made) rmSync(dir, { recursive: true, force: true });
        throw e;
      }
      console.log(`seeded ${profileLayout(dir).root}`);
    }
  }
  if (command !== "init") openProfile(dir);
}
