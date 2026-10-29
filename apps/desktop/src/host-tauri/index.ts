// Host implemented with Tauri plugins and the app's few commands (architecture.md §2.1, §2.4), one file
// per port.
import { appDataDir, homeDir } from "@tauri-apps/api/path";
import type { Host } from "@loadout/core";
import type { AuditLog } from "./audit.ts";
import { createTauriFs } from "./fs.ts";
import { createTauriHttp } from "./http.ts";
import { createTauriProc } from "./proc.ts";
import { createTauriSecrets } from "./secrets.ts";

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
  return {
    fs: createTauriFs(paths.appData),
    proc: createTauriProc(log.record),
    secrets: createTauriSecrets(),
    http: createTauriHttp(),
    paths,
    now: () => new Date(),
    sha256,
    audit: log.record,
  };
}
