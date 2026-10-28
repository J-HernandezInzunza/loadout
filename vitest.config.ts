import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: "core", root: "packages/core", environment: "node" } },
      { test: { name: "host-node", root: "packages/host-node", environment: "node" } },
      { test: { name: "repo", root: "test", environment: "node" } },
      "apps/desktop",
    ],
  },
});
