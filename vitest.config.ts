import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Belt and braces for hermetic git tests (architecture.md §6): only file:// remotes work.
    env: { GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
    projects: [
      // Real git against file:// repos: a test that takes 0.7 s alone can pass 5 s when the whole suite runs in
      // parallel on a busy machine, so the default timeout reported contention as failure.
      { test: { name: "core", root: "packages/core", environment: "node", testTimeout: 15_000 } },
      { test: { name: "host-node", root: "packages/host-node", environment: "node", testTimeout: 15_000 } },
      { test: { name: "repo", root: "test", environment: "node" } },
      "apps/desktop",
    ],
  },
});
