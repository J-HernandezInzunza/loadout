import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPEARANCES, applyAppearance, nextAppearance, storedAppearance } from "./theme.ts";

describe("UI-53: appearance", () => {
  const calls: [string, unknown][] = [];

  beforeEach(() => {
    localStorage.clear();
    calls.length = 0;
    mockIPC((cmd, payload) => void calls.push([cmd, payload]));
  });
  afterEach(() => clearMocks());

  it("follows the system until told otherwise, and on a value it does not recognise", () => {
    expect(storedAppearance()).toBe("system");
    localStorage.setItem("library.appearance", "sepia");
    expect(storedAppearance()).toBe("system");
  });

  it("cycles System → Light → Dark and back", () => {
    expect(APPEARANCES.map(nextAppearance)).toEqual(["light", "dark", "system"]);
  });

  it("sets the native theme, null for system, and remembers the choice for the next launch", async () => {
    await applyAppearance("system");
    await applyAppearance("dark");

    expect(calls).toEqual([
      ["plugin:app|set_app_theme", { theme: null }],
      ["plugin:app|set_app_theme", { theme: "dark" }],
    ]);
    expect(storedAppearance()).toBe("dark");
  });
});
