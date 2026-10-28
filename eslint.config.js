// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

const nodeBuiltins = ["fs", "path", "os", "child_process", "crypto", "url", "stream", "process", "util"];

export default defineConfig([
  globalIgnores(["**/dist/", "**/node_modules/", "apps/desktop/src-tauri/target/", "apps/desktop/src-tauri/gen/"]),
  {
    files: ["**/*.{js,ts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.vue"],
    extends: [pluginVue.configs["flat/recommended"]],
    languageOptions: { parserOptions: { parser: tseslint.parser }, globals: globals.browser },
  },
  {
    // The core runs in the webview behind the Host port (architecture.md §2.1, §8.1).
    files: ["packages/core/**/*.{js,ts}"],
    // Tests run on Node: they read fixtures and build the sandbox host.
    ignores: ["packages/core/**/*.test.ts", "packages/core/test/**"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["vue", "vue/*", "@vue/*", "pinia"], message: "packages/core may not import Vue: the UI renders core results." },
            { group: ["@tauri-apps/*"], message: "packages/core may not import Tauri: go through the Host port." },
            { group: ["node:*", ...nodeBuiltins, ...nodeBuiltins.map((m) => `${m}/*`)], message: "packages/core may not import Node built-ins: go through the Host port." },
          ],
        },
      ],
    },
  },
]);
