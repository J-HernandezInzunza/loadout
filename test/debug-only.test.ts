// What only debug builds may carry. The embedded WebDriver server lets anything on the machine drive the app
// (M16.11, S17): an optional dependency behind the webdriver feature, its permission only in the config those
// builds merge, and a release build with the feature refusing to compile. A debug profile's secrets file
// (M16, secrets.rs) bypasses the Keychain: its module is compiled only into debug builds, so any use of it
// outside them fails to compile.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tauri = (path: string) => fileURLToPath(new URL(`../apps/desktop/src-tauri/${path}`, import.meta.url));
const read = (path: string) => readFileSync(tauri(path), "utf8");

interface Manifest {
  features: Record<string, string[]>;
  dependencies: { name: string; optional: boolean }[];
}
const manifest = (JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1", "--manifest-path", tauri("Cargo.toml")], { encoding: "utf8" })) as { packages: Manifest[] }).packages[0]!;

describe("the WebDriver plugin stays out of release builds", () => {
  it("is an optional dependency, enabled only by the webdriver feature", () => {
    expect(manifest.dependencies.find((d) => d.name === "tauri-plugin-wdio-webdriver")?.optional).toBe(true);
    expect(manifest.features.webdriver).toEqual(["dep:tauri-plugin-wdio-webdriver"]);
    expect(manifest.features.default ?? []).not.toContain("webdriver");
  });

  it("refuses a release build with the feature", () => {
    expect(read("src/lib.rs")).toMatch(/#\[cfg\(all\(\s*feature\s*=\s*"webdriver",\s*not\(debug_assertions\)\s*\)\)\]\s*compile_error!/);
  });

  it("has its permission only in the webdriver config", () => {
    expect(read("capabilities/default.json")).not.toContain("wdio-webdriver");
    expect(read("tauri.conf.json")).not.toContain("wdio-webdriver");
    expect(read("tauri.webdriver.conf.json")).toContain('"wdio-webdriver:default"');
  });
});

describe("a debug profile's secrets file stays out of release builds", () => {
  it("lives in a module compiled only into debug builds", () => {
    expect(read("src/secrets.rs")).toMatch(/#\[cfg\(debug_assertions\)\]\s*mod profile_file\s*\{/);
  });
});
