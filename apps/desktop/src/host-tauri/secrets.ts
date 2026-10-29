// HostSecrets over the app's Keychain commands (architecture.md §5.5; src-tauri/src/secrets.rs).
import { invoke } from "@tauri-apps/api/core";
import type { HostSecrets } from "@loadout/core";

/** `invoke` with a command's error string turned into an Error. */
function call<T>(cmd: string, args: Record<string, string>): Promise<T> {
  return invoke<T>(cmd, args).catch((e: unknown) => Promise.reject(e instanceof Error ? e : new Error(`${cmd}: ${String(e)}`)));
}

export function createTauriSecrets(): HostSecrets {
  return {
    get: (key) => call<string | null>("secret_get", { key }),
    set: (key, value) => call<void>("secret_set", { key, value }),
    delete: (key) => call<void>("secret_delete", { key }),
  };
}
