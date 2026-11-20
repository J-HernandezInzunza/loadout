// Debug profiles (M16.09, M16.10): a folder whose `home/` the app runs with as HOME. The app's `.claude`, app
// data and fs scope all follow HOME (S17). Its tokens don't go to the Keychain: macOS 26 won't give a moved HOME
// a keychain that is both its default and unlockable, so a debug build keeps them in the profile's owner-only
// `secrets.json` instead, which LOADOUT_PROFILE_SECRETS names (src-tauri/src/secrets.rs). `demo`
// (npm run app:profile -- <dir>) builds the debug app, makes and seeds a new profile, and opens it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
  // Beside home, not in it, so nothing the app or a skill does in its HOME comes across it.
  return { root, home, secrets: join(root, "secrets.json") };
}

/** Makes the profile's home; a profile already made is left as it is. */
export function initProfile(dir: string): ReturnType<typeof profileLayout> {
  const p = profileLayout(dir);
  mkdirSync(p.home, { recursive: true });
  return p;
}

/** Stores a secret where the app on this profile reads it, as its secret_set would. */
export function setProfileSecret(dir: string, key: string, value: string): void {
  const { secrets } = profileLayout(dir);
  const stored = existsSync(secrets) ? (JSON.parse(readFileSync(secrets, "utf8")) as Record<string, string>) : {};
  writeFileSync(secrets, JSON.stringify({ ...stored, [key]: value }, null, 2), { mode: 0o600 });
}

/**
 * Fills a new profile with the demo machine (M16.10), through the core over the profile's home and app data
 * as the app finds them. Git runs with the real user's credentials, which the seed's push to the demo repo
 * needs; the profile's home gets its own git identity, for the commits the app makes there.
 */
export async function seedProfile(dir: string): Promise<void> {
  const p = profileLayout(dir);
  writeFileSync(join(p.home, ".gitconfig"), "[user]\n\tname = Loadout Demo\n\temail = demo@loadout.invalid\n");
  await seedDemo(profileHost(dir));
}

/**
 * The environment the app starts with: what launchd gives a Finder launch, with the profile's HOME. Nothing
 * else from the calling shell, so a variable such as CLAUDE_CONFIG_DIR can't point the app back at the real
 * user's files; the app repairs PATH from the profile's login shell, as it does when launched from Finder.
 */
export function profileEnv(dir: string, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const p = profileLayout(dir);
  const kept = ["USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "__CF_USER_TEXT_ENCODING"].flatMap((k) => (from[k] ? [[k, from[k]]] : []));
  return { ...Object.fromEntries(kept), HOME: p.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LOADOUT_PROFILE_SECRETS: p.secrets };
}

/** Starts the built debug app on the profile; flows stop it themselves. */
export function startApp(dir: string, stdio: "inherit" | "ignore" = "inherit"): ChildProcess {
  const p = profileLayout(dir);
  if (!existsSync(p.home)) throw new Error(`${p.root} is not a profile yet: run init first`);
  if (!existsSync(debugApp)) throw new Error(`no debug build at ${debugApp}: npm run app:build:debug`);
  // The app caches what the login shell reported; probing afresh keeps that the profile's own.
  rmSync(join(p.home, "Library/Application Support", identifier, "shell-env.json"), { force: true });
  return spawn(debugApp, [], { env: profileEnv(dir), stdio });
}

/** The core over the profile's home and app data, as the app finds them. */
export function profileHost(dir: string) {
  const { home } = profileLayout(dir);
  return createNodeHost({ home, appData: join(home, "Library/Application Support", identifier) });
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
    // The same debug build flows use, its WebDriver server included (M16.11).
    execFileSync("npm", ["run", "app:build:debug"], { cwd: repo, stdio: "inherit" });
    if (!existsSync(profileLayout(dir).home)) {
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
  if (command !== "init") startApp(dir).on("exit", (code) => process.exit(code ?? 0));
}
