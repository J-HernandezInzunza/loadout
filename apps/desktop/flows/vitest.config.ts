import { defineConfig } from "vitest/config";

// Flows drive the real app (M16.11): one at a time, since the WebDriver port and the app's single-instance
// lock are shared, and slow, since they clone the demo repo and talk to GitHub. Not part of `npm test`.
export default defineConfig({
  test: {
    name: "flows",
    root: import.meta.dirname,
    include: ["*.flow.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
