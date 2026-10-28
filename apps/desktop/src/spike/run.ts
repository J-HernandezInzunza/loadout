// M0 spikes that need the real bundle launched by LaunchServices (as Finder does): docs/spec/spikes.md.
// Built only with VITE_SPIKE=1. Writes $APPDATA/spike-results.json; secrets are never recorded.
import { appDataDir, homeDir, join } from "@tauri-apps/api/path";
import { mkdir, readDir, readFile, remove, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";

type Result = Record<string, unknown>;

const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}

async function run(program: "git" | "gh", args: string[], env: Record<string, string> = {}) {
  const started = performance.now();
  try {
    const out = await within(20_000, Command.create(program, args, { env }).execute());
    return { code: out.code, stdout: out.stdout.trim(), stderr: out.stderr.trim(), ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { spawnError: String(err), ms: Math.round(performance.now() - started) };
  }
}

/** Environment the git child sees, via a shell alias (git is the only program in scope). */
async function childEnv(): Promise<Result> {
  const r = await run("git", ["-c", "alias.spikeenv=!env", "spikeenv"]);
  const env = Object.fromEntries(
    ("stdout" in r ? r.stdout : "").split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return {
    PATH: env.PATH,
    SSH_AUTH_SOCK: env.SSH_AUTH_SOCK ? "set" : "unset",
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? "unset",
    HOME: env.HOME,
  };
}

async function resolution(): Promise<Result> {
  const which = await run("git", ["-c", "alias.spikewhich=!command -v git gh", "spikewhich"]);
  return { which, git: await run("git", ["--version"]), gh: await run("gh", ["--version"]) };
}

async function credentials(): Promise<Result> {
  await crumb("credentials: ssh ls-remote");
  const ssh = await run("git", ["ls-remote", "git@github.com:J-HernandezInzunza/loadout.git", "HEAD"], NON_INTERACTIVE);
  const helpers = await run("git", ["config", "--get-all", "credential.helper"]);
  // Ask the credential helper for github.com through a child with stdin; record only whether it answered.
  // A private repo over https with prompts off: succeeds only if the keychain helper supplies credentials.
  await crumb("credentials: https ls-remote of a private repo");
  const https = await run("git", ["ls-remote", "https://github.com/J-HernandezInzunza/mentoring-docs.git", "HEAD"], {
    ...NON_INTERACTIVE,
    GIT_ASKPASS: "/usr/bin/true",
  });
  await crumb("credentials: gh auth status");
  const ghAuth = await run("gh", ["auth", "status"]);
  return {
    sshLsRemote: { code: ssh.code, ms: ssh.ms, stderr: "stderr" in ssh ? ssh.stderr.slice(0, 300) : ssh.spawnError },
    credentialHelpers: "stdout" in helpers ? helpers.stdout.split("\n") : helpers,
    httpsPrivateLsRemote: { code: https.code, ms: https.ms, stderr: "stderr" in https ? https.stderr.slice(0, 300) : https.spawnError },
    ghAuthStatus: { code: ghAuth.code, ok: ghAuth.code === 0 },
  };
}

/** The largest skill under ~/.claude/skills, walked, read, hashed and copied through plugin-fs. */
async function fsSpeed(): Promise<Result> {
  const skills = await join(await homeDir(), ".claude", "skills");
  const walk = async (dir: string, rel = ""): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readDir(dir)) {
      if (e.isSymlink) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) out.push(...(await walk(await join(dir, e.name), r)));
      else if (e.isFile) out.push(r);
    }
    return out;
  };
  let largest = { name: "", files: [] as string[] };
  for (const e of await readDir(skills)) {
    if (!e.isDirectory || e.name.startsWith(".")) continue;
    const files = await walk(await join(skills, e.name));
    if (files.length > largest.files.length) largest = { name: e.name, files };
  }
  const src = await join(skills, largest.name);
  const dest = await join(await appDataDir(), "tmp", "spike-copy");

  const t0 = performance.now();
  await walk(src);
  const t1 = performance.now();
  let bytes = 0;
  const contents: Uint8Array<ArrayBuffer>[] = [];
  for (const f of largest.files) {
    const data = (await readFile(await join(src, f))) as Uint8Array<ArrayBuffer>;
    bytes += data.length;
    contents.push(data);
  }
  const t2 = performance.now();
  for (const data of contents) await crypto.subtle.digest("SHA-256", data);
  const t3 = performance.now();
  await remove(dest, { recursive: true }).catch(() => {});
  for (const [i, f] of largest.files.entries()) {
    const target = await join(dest, f);
    await mkdir(await join(target, ".."), { recursive: true });
    await writeFile(target, contents[i]!);
  }
  const t4 = performance.now();
  await remove(dest, { recursive: true });
  return {
    skill: largest.name,
    files: largest.files.length,
    bytes,
    ms: { walk: Math.round(t1 - t0), read: Math.round(t2 - t1), sha256: Math.round(t3 - t2), copy: Math.round(t4 - t3) },
  };
}

/** Side channel that needs only the shell plugin: append a line to ~/Library/Logs/loadout-spike.log. */
async function crumb(line: string): Promise<void> {
  await Command.create("git", ["-c", 'alias.crumb=!f() { printf "%s\\n" "$1" >> "$HOME/Library/Logs/loadout-spike.log"; }; f', "crumb", line])
    .execute()
    .catch(() => {});
}

export async function runSpikes(): Promise<void> {
  await crumb(`start ${new Date().toISOString()}`);
  const results: Result = { startedAt: new Date().toISOString() };
  for (const [name, probe] of Object.entries({ childEnv, resolution, fsSpeed, credentials })) {
    try {
      results[name] = await probe();
      await crumb(`ok ${name}`);
    } catch (err) {
      results[name] = { error: String(err) };
      await crumb(`error ${name}: ${String(err)}`);
    }
  }
  const json = JSON.stringify(results, null, 2);
  try {
    const dir = await appDataDir();
    await mkdir(dir, { recursive: true });
    await writeTextFile(await join(dir, "spike-results.json"), json);
    await crumb("wrote results via plugin-fs");
  } catch (err) {
    await crumb(`plugin-fs write failed: ${String(err)}`);
    await crumb(`results ${JSON.stringify(results)}`);
  }
  document.body.textContent = "Spikes done.";
}
