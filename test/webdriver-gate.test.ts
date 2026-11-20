// The embedded WebDriver server lets anything on the machine drive the app (M16.11, S17), so only a debug build
// with the webdriver feature may carry it: an optional dependency behind the feature, its permission only in the
// config those builds merge, and a release build with the feature refusing to compile.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../apps/desktop/src-tauri/${path}`, import.meta.url), "utf8");

describe("the WebDriver plugin stays out of release builds", () => {
  it("is an optional dependency, enabled only by the webdriver feature", () => {
    const cargo = read("Cargo.toml");
    expect(cargo).toMatch(/^tauri-plugin-wdio-webdriver = \{[^}]*optional = true[^}]*\}$/m);
    expect(cargo).toMatch(/^webdriver = \["dep:tauri-plugin-wdio-webdriver"\]$/m);
    expect(cargo).not.toMatch(/^default = .*webdriver/m);
  });

  it("is registered only under the feature, and the feature refuses a release build", () => {
    const lib = read("src/lib.rs");
    expect(lib).toContain('#[cfg(feature = "webdriver")]\n    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());');
    expect(lib).toContain('#[cfg(all(feature = "webdriver", not(debug_assertions)))]\ncompile_error!');
  });

  it("has its permission only in the webdriver config", () => {
    expect(read("capabilities/default.json")).not.toContain("wdio-webdriver");
    expect(read("tauri.conf.json")).not.toContain("wdio-webdriver");
    expect(read("tauri.webdriver.conf.json")).toContain('"wdio-webdriver:default"');
  });
});
