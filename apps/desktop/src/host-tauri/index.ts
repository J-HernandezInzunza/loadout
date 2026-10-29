// Host implemented with Tauri plugins (architecture.md §2.1), one file per port. Ports not built yet
// reject every call, so nothing in the webview reaches the system before its adapter and mockIPC tests exist.
import { appDataDir, homeDir } from "@tauri-apps/api/path";
import type { Host, HostHttp } from "@loadout/core";
import type { AuditLog } from "./audit.ts";
import { createTauriFs } from "./fs.ts";
import { createTauriProc } from "./proc.ts";
import { createTauriSecrets } from "./secrets.ts";

function notImplemented(name: string) {
  return () => Promise.reject(new Error(`host-tauri: ${name} is not implemented yet (M4)`));
}

/** The user's home and the app's data folder (`~/Library/Application Support/<identifier>`). */
export async function tauriPaths(): Promise<Host["paths"]> {
  return { home: await homeDir(), appData: await appDataDir() };
}

async function sha256(data: Uint8Array): Promise<string> {
  // A copy, since subtle.digest takes only ArrayBuffer-backed views.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createTauriHost(paths: Host["paths"], log: AuditLog): Host {
  const http: HostHttp = { request: notImplemented("http.request") };

  return {
    fs: createTauriFs(paths.appData),
    proc: createTauriProc(log.record),
    secrets: createTauriSecrets(),
    http,
    paths,
    now: () => new Date(),
    sha256,
    audit: log.record,
  };
}
