import { createLibrary, type Host } from "@loadout/core";
import { createPinia } from "pinia";
import { createApp } from "vue";
import DebugView from "./DebugView.vue";
import { createAuditLog } from "./host-tauri/audit.ts";
import { createTauriHost, tauriPaths } from "./host-tauri/index.ts";

/** CLAUDE_CONFIG_DIR as the login-shell probe found it; Rust caches the probe in app data (src-tauri/src/path.rs). */
async function claudeConfigDir(host: Host): Promise<string | undefined> {
  try {
    const cached: unknown = JSON.parse(await host.fs.readText(`${host.paths.appData}/shell-env.json`));
    const dir = (cached as { claudeConfigDir?: unknown }).claudeConfigDir;
    return typeof dir === "string" ? dir : undefined;
  } catch {
    return undefined;
  }
}

const log = createAuditLog();
const host = createTauriHost(await tauriPaths(), log);
const configDir = await claudeConfigDir(host);
const library = createLibrary(host, configDir === undefined ? {} : { claudeConfigDir: configDir });
const launched = library.launch();

createApp(DebugView, { library, log, launched }).use(createPinia()).mount("#app");
