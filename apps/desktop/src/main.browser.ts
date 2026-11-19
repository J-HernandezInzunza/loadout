// Browser mode (M16.05): the app in a plain browser, over the real core, against the demo server's seeded
// sandbox (`npm run demo`). index.html loads this instead of main.ts only in that mode, so nothing here
// reaches a release build.
import { createLibrary } from "@loadout/core";
import { createBridgeHost, fetchSession } from "@loadout/sandbox/bridge";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createPinia } from "pinia";
import { createApp } from "vue";
import "./assets/tokens.css";
import "./assets/app.css";
import { version } from "../package.json";
import App from "./App.vue";
import { createAuditLog } from "./host-tauri/audit.ts";
import { auditLogKey, libraryKey } from "./services.ts";
import { applyAppearance, storedAppearance } from "./theme.ts";

/** What the page did outside itself, for flows to read: opener calls are recorded, not carried out. */
export interface DemoPage {
  opened: { cmd: string; payload: unknown }[];
}

declare global {
  interface Window {
    __demo: DemoPage;
  }
}

const base = "/__demo";
const session = await fetchSession(base);
window.__demo = { opened: [] };

// The Tauri calls the UI makes itself (S16); the core's go over the bridge instead.
mockWindows("main");
mockIPC(
  (cmd, payload) => {
    if (cmd.startsWith("plugin:opener|")) return void window.__demo.opened.push({ cmd, payload });
    switch (cmd) {
      case "plugin:app|version":
        return version;
      // The file dialog picks the sandbox's home, as if the user chose it.
      case "plugin:dialog|open":
        return session.paths.home;
      // Appearance follows the browser's colour scheme, so the native theme has nothing to do.
      case "plugin:app|set_app_theme":
      case "plugin:window|set_focus":
        return null;
      default:
        console.warn(`[demo] unanswered Tauri call ${cmd}`, payload);
        return null;
    }
  },
  { shouldMockEvents: true },
);

// Chromium has no ui-monospace and finds no SFMono-Regular, so code would fall to Courier (S16).
const monospace = document.createElement("style");
monospace.textContent = `@font-face { font-family: "SFMono-Regular"; src: local("SF Mono Regular"), local("SFMono-Regular"), local("Menlo-Regular"); }`;
document.head.append(monospace);

void applyAppearance(storedAppearance());

const log = createAuditLog();
const host = createBridgeHost(base, session.paths, log.record);
// GitHub's device flow runs against the API stub; any client ID does.
const library = createLibrary(host, { apiBases: session.apiBases, githubClientId: "demo" });

createApp(App).use(createPinia()).provide(libraryKey, library).provide(auditLogKey, log).mount("#app");
