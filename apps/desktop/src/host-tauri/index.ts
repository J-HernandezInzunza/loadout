// Host implemented with Tauri plugins (architecture.md §2.1), one file per port. Ports not built yet
// reject every call, so nothing in the webview reaches the system before its adapter and mockIPC tests exist.
import type { Host, HostHttp, HostProc, HostSecrets } from "@loadout/core";
import { createTauriFs } from "./fs.ts";

function notImplemented(name: string) {
  return () => Promise.reject(new Error(`host-tauri: ${name} is not implemented yet (M4)`));
}

export function createTauriHost(paths: Host["paths"]): Host {
  const proc: HostProc = { run: notImplemented("proc.run") };
  const secrets: HostSecrets = {
    get: notImplemented("secrets.get"),
    set: notImplemented("secrets.set"),
    delete: notImplemented("secrets.delete"),
  };
  const http: HostHttp = { request: notImplemented("http.request") };

  return {
    fs: createTauriFs(paths.appData),
    proc,
    secrets,
    http,
    paths,
    now: () => new Date(),
    sha256: notImplemented("sha256"),
    audit: () => {},
  };
}
