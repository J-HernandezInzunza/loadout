// Browser mode (M16.05) is for `npm run demo` only: a release bundle must carry none of the bridge, the
// demo entry or the sandbox. The same strings are looked for in a browser-mode build, so a marker that
// stopped matching can't make this pass.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("../apps/desktop", import.meta.url));
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** One string from each piece of browser mode: the bridge client, the demo entry, the sandbox's guard. */
const markers = ["/__demo", "the demo server answered", "unanswered Tauri call", "escapes the sandbox"];

async function bundle(mode: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), `loadout-bundle-${mode}-`));
  temps.push(outDir);
  await build({ root: app, configFile: join(app, "vite.config.ts"), mode, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  return readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && /\.(js|html)$/.test(f.name))
    .map((f) => readFileSync(join(f.parentPath, f.name), "utf8"))
    .join("\n");
}

describe("browser mode stays out of the release bundle", () => {
  it("a browser-mode build carries the bridge and the demo entry", { timeout: 60_000 }, async () => {
    const code = await bundle("browser");
    expect(markers.slice(0, 3).filter((m) => code.includes(m))).toEqual(markers.slice(0, 3));
  });

  it("a release build carries none of it", { timeout: 60_000 }, async () => {
    const code = await bundle("production");
    // main.ts's own string, so an empty bundle can't pass.
    expect(code).toContain("shell-env.json");
    expect(markers.filter((m) => code.includes(m))).toEqual([]);
  });
});
