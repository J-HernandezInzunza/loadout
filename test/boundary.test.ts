// The core runs in the webview behind the Host port (architecture.md §2.1, §8.1): it may not import
// UI frameworks, Tauri, or Node built-ins. This test pins the ESLint rule that enforces it.
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function restrictedImportErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

const forbidden = [
  'import { ref } from "vue";',
  'import { defineStore } from "pinia";',
  'import { invoke } from "@tauri-apps/api/core";',
  'import { readTextFile } from "@tauri-apps/plugin-fs";',
  'import { readFile } from "node:fs/promises";',
  'import { join } from "path";',
  'import { spawn } from "child_process";',
];

describe("packages/core import boundary", () => {
  it.each(forbidden)("rejects %s", async (code) => {
    expect(await restrictedImportErrors(code, "packages/core/src/x.ts")).toHaveLength(1);
  });

  it("allows relative imports inside the core", async () => {
    expect(await restrictedImportErrors('import type { Host } from "./host.ts";', "packages/core/src/x.ts")).toEqual([]);
  });

  it.each(["packages/core/src/x.test.ts", "packages/core/test/sandbox.ts"])(
    "lets the core's tests use Node built-ins (%s)",
    async (filePath) => {
      expect(await restrictedImportErrors('import { readFile } from "node:fs/promises";', filePath)).toEqual([]);
    },
  );

  it("does not restrict the desktop app", async () => {
    expect(await restrictedImportErrors('import { ref } from "vue";', "apps/desktop/src/x.ts")).toEqual([]);
  });
});
