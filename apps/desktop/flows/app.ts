// What every flow (M16.11) runs on: the real debug app, built with the webdriver feature, on a freshly seeded
// profile connected to GitHub with the flows' token (token.ts), driven over the embedded WebDriver server (S17).
import { execFileSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createLibrary } from "@loadout/core";
import { remote } from "webdriverio";
import { initProfile, profileHost, profileLayout, seedProfile, setProfileSecret, startApp } from "../../../tools/profile.ts";
import { pointAt, recording, settle, startRecording } from "./recording.ts";

const port = 4445;

export type Browser = WebdriverIO.Browser;

export interface RunningApp {
  browser: Browser;
  /** the profile's home, where the app's `.claude` lives */
  home: string;
  close(): Promise<void>;
}

async function ready(app: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`the app quit before its WebDriver server came up (exit ${app.exitCode})`);
    const status = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json() as Promise<{ value: { ready: boolean } }>, () => null);
    if (status?.value.ready) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the app's WebDriver server didn't come up: is the build missing the webdriver feature?");
}

/**
 * Loadout runs one instance at a time, whatever its HOME: a second one hands over to the first and quits, so a
 * flow would drive the wrong app. The installed app counts too.
 */
function refuseIfRunning(): void {
  const running = (() => {
    try {
      return execFileSync("pgrep", ["-x", "loadout"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();
  if (running) throw new Error(`Loadout is already running (pid ${running.split("\n").join(", ")}): quit it (Cmd-Q, not just its window), since only one instance runs at a time`);
}

const exited = (app: ChildProcess) => app.exitCode !== null || app.signalCode !== null;

/** Starts the app on a profile and opens a WebDriver session on it. */
export async function openApp(dir: string): Promise<RunningApp> {
  refuseIfRunning();
  const app = startApp(dir, "ignore");
  try {
    await ready(app);
    // The server that answered must be this app's, not one it handed over to.
    await new Promise((r) => setTimeout(r, 500));
    if (exited(app)) throw new Error("the app quit right after starting: is another Loadout running?");
  } catch (e) {
    app.kill();
    throw e;
  }
  const browser = await remote({ hostname: "127.0.0.1", port, path: "/", capabilities: {}, logLevel: "warn" });
  // WebKit stops animating a window that's covered, leaving a fade-in at opacity 0, which WebDriver reads as not
  // displayed. Flows check behavior, so they run without motion, as the app does under reduced motion; a
  // recording keeps it, with the window in front.
  if (!recording) await browser.execute(() => document.head.append(Object.assign(document.createElement("style"), { textContent: "*, *::before, *::after { animation: none !important; transition: none !important; }" })));
  // In record mode (npm run record), the recorder films from here until close.
  const stopRecording = await startRecording(browser, app.pid!, () => invoke(browser, "plugin:window|set_focus", { label: "main" }));
  return {
    browser,
    home: profileLayout(dir).home,
    async close() {
      try {
        await stopRecording();
      } finally {
        // The app quits even when the recording failed, or the next flow finds it still running.
        await browser.deleteSession().catch(() => {});
        if (!exited(app)) {
          const gone = new Promise((r) => app.once("exit", r));
          app.kill();
          await gone;
        }
      }
    },
  };
}

/** One of the app's own commands, invoked from the page. */
export async function invoke<T>(browser: Browser, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  // Runs in the page: Tauri's own IPC, as the app's frontend calls it.
  const run = (cmd: string, args: Record<string, unknown>, done: (r: { ok: unknown } | { err: string }) => void) => {
    const tauri = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
    tauri.invoke(cmd, args).then((ok) => done({ ok }), (e: unknown) => done({ err: String(e) }));
  };
  const result = (await browser.executeAsync(run as never, cmd, args)) as { ok: unknown } | { err: string };
  if ("err" in result) throw new Error(`${cmd}: ${result.err}`);
  return result.ok as T;
}

/**
 * A freshly seeded profile in a temp folder, connected to GitHub with `token`: the core records the account,
 * and the token goes where the app on the profile reads its secrets. Removed by `dispose`.
 */
export async function freshProfile(token: string): Promise<{ dir: string; open(): Promise<RunningApp>; dispose(): void }> {
  // A short, fixed place, since the app shows its paths (and recordings film them); one flow runs at a time.
  const root = "/tmp/loadout-demo";
  rmSync(root, { recursive: true, force: true });
  const dir = root;
  initProfile(dir);
  await seedProfile(dir);
  const connected = await createLibrary(profileHost(dir)).connect("github", JSON.parse(token) as never);
  if (!connected.ok) throw new Error(`connecting GitHub in the fresh profile: ${connected.error.message}`);
  setProfileSecret(dir, "github", token);
  return {
    dir,
    open: () => openApp(dir),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A button by its accessible name (its text or aria-label), not any element of that name (S17). */
export const button = (browser: Browser, name: string) =>
  browser.$(`//button[normalize-space(.)=${JSON.stringify(name)} or @aria-label=${JSON.stringify(name)}]`);

/** Waits for a button, then clicks it; recording, the cursor travels there first. */
export async function press(browser: Browser, name: string): Promise<void> {
  const el = await button(browser, name);
  await el.waitForClickable({ timeout: 15_000, timeoutMsg: `no clickable button "${name}"` });
  await pointAt(browser, el);
  await el.click();
  await settle();
}

/** Waits for text anywhere on the page. */
export async function sees(browser: Browser, text: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(async () => ((await browser.$("body").getText()) ?? "").includes(text), { timeout, timeoutMsg: `"${text}" never showed` });
}
