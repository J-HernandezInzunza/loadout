import vue from "@vitejs/plugin-vue";
import { defineProject } from "vitest/config";

// Tauri expects a fixed dev port and serves dist/ in release builds.
export default defineProject({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari17", outDir: "dist" },
  // The OAuth clients from .env.local or CI. The Bitbucket secret ships inside the app by design: alone it
  // grants nothing (QUESTIONS.md Q5).
  envPrefix: ["VITE_", "LOADOUT_GITHUB_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_SECRET"],
  // css: the style guards read stylesheets with ?raw, which vitest otherwise stubs to "".
  test: { name: "desktop", environment: "jsdom", css: true },
});
