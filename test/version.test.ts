// One version for the whole app (R.01): apps/desktop/package.json holds it, tauri.conf.json reads it from
// there, and every other copy agrees, so the release tag (R.02) and the running app can't disagree.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readVersions, setVersion, VERSION_FILES } from "../tools/version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temps: string[] = [];

function copyOfRepo() {
  const dir = mkdtempSync(join(tmpdir(), "loadout-version-"));
  temps.push(dir);
  // cpSync creates a file's missing parent folders when recursive.
  for (const file of VERSION_FILES) cpSync(join(root, file), join(dir, file), { recursive: true });
  return dir;
}

/** the lines that differ between two texts of the same length in lines */
const changedLines = (before: string, after: string) => {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  return b.filter((line, i) => line !== a[i]);
};

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("version", () => {
  it("is the same in every file, and tauri.conf.json reads it from the desktop package.json", () => {
    const tauri = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
    expect(tauri.version).toBe("../package.json");

    const versions = readVersions(root);
    const desktop = versions["apps/desktop/package.json"];
    expect(desktop).toMatch(/^\d+\.\d+\.\d+/);
    for (const [file, version] of Object.entries(versions)) expect({ file, version }).toEqual({ file, version: desktop });
  });

  it("version:set changes the version line in each file and nothing else", () => {
    const dir = copyOfRepo();
    const before = Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(dir, f), "utf8")]));

    setVersion(dir, "1.2.3-rc.4");

    expect(new Set(Object.values(readVersions(dir)))).toEqual(new Set(["1.2.3-rc.4"]));
    for (const file of VERSION_FILES) {
      const changed = changedLines(before[file]!, readFileSync(join(dir, file), "utf8"));
      const lines = file === "package-lock.json" ? 3 : 1;
      expect(changed, file).toHaveLength(lines);
      for (const line of changed) expect(line, file).toMatch(/^\s*"?version"?(:| =) "1\.2\.3-rc\.4",?$/);
    }
  });

  it("version:set refuses what isn't a version, and writes nothing", () => {
    const dir = copyOfRepo();
    const before = readVersions(dir);
    for (const bad of ["v0.1.0", "0.1", "0.1.0-", "01.0.0", ""]) expect(() => setVersion(dir, bad), bad).toThrow(/not a version/);
    expect(readVersions(dir)).toEqual(before);
  });
});
