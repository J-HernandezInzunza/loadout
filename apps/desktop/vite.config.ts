import vue from "@vitejs/plugin-vue";
import { defineProject } from "vitest/config";

// Tauri expects a fixed dev port and serves dist/ in release builds.
export default defineProject({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari17", outDir: "dist" },
  test: { name: "desktop", environment: "jsdom" },
});
