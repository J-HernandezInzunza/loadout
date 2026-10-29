import vue from "@vitejs/plugin-vue";
import { defineProject } from "vitest/config";

// Tauri expects a fixed dev port and serves dist/ in release builds.
export default defineProject({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari17", outDir: "dist" },
  // OAuth client IDs are public; the Bitbucket secret is deliberately not among these.
  envPrefix: ["VITE_", "LOADOUT_GITHUB_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_ID"],
  test: { name: "desktop", environment: "jsdom" },
});
