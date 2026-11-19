import { demoBridge } from "@loadout/sandbox/vite";
import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
import { defineProject } from "vitest/config";

/** Browser mode (M16.05) only: index.html loads main.browser.ts, over the demo bridge, instead of main.ts. */
const browserEntry: Plugin = {
  name: "loadout-browser-entry",
  // pre: before Vite collects the page's scripts, or a build would still bundle main.ts.
  transformIndexHtml: { order: "pre", handler: (html) => html.replace("/src/main.ts", "/src/main.browser.ts") },
};

// Tauri expects a fixed dev port and serves dist/ in release builds.
export default defineProject(({ mode }) => ({
  plugins: [vue(), ...(mode === "browser" ? [browserEntry, demoBridge()] : [])],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari17", outDir: "dist" },
  // The OAuth clients from .env.local or CI. The Bitbucket secret ships inside the app by design: alone it
  // grants nothing (QUESTIONS.md Q5).
  envPrefix: ["VITE_", "LOADOUT_GITHUB_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_SECRET"],
  // css: the style guards read stylesheets with ?raw, which vitest otherwise stubs to "".
  test: { name: "desktop", environment: "jsdom", css: true },
}));
