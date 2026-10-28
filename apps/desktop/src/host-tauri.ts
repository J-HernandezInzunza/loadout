// Host implemented with Tauri plugins (architecture.md §2.1). A stub until M4: every call rejects, so
// nothing in the webview can reach the system before the real adapter and its mockIPC tests exist.
import type { Host, HostFs, HostHttp, HostProc, HostSecrets } from "@loadout/core";

function notImplemented(name: string) {
  return () => Promise.reject(new Error(`host-tauri: ${name} is not implemented yet (M4)`));
}

export function createTauriHost(paths: Host["paths"]): Host {
  const fsMethods: (keyof HostFs)[] = [
    "readText",
    "readBytes",
    "writeTextAtomic",
    "writeBytes",
    "exists",
    "stat",
    "lstat",
    "realPath",
    "readDir",
    "mkdirp",
    "rename",
    "copyFile",
    "remove",
    "makeTempDir",
  ];
  const fs = Object.fromEntries(fsMethods.map((m) => [m, notImplemented(`fs.${m}`)])) as unknown as HostFs;
  const proc: HostProc = { run: notImplemented("proc.run") };
  const secrets: HostSecrets = {
    get: notImplemented("secrets.get"),
    set: notImplemented("secrets.set"),
    delete: notImplemented("secrets.delete"),
  };
  const http: HostHttp = { request: notImplemented("http.request") };

  return {
    fs,
    proc,
    secrets,
    http,
    paths,
    now: () => new Date(),
    sha256: notImplemented("sha256"),
    audit: () => {},
  };
}
