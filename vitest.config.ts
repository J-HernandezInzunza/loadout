import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Belt and braces for hermetic git tests (architecture.md §6): only file:// remotes work.
    env: { GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
    projects: [
      { test: { name: "core", root: "packages/core", environment: "node" } },
      { test: { name: "host-node", root: "packages/host-node", environment: "node" } },
      { test: { name: "repo", root: "test", environment: "node" } },
      "apps/desktop",
    ],
  },
});
