import { flushPromises, mount } from "@vue/test-utils";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AppearanceToggle from "./AppearanceToggle.vue";

describe("UI-53: AppearanceToggle", () => {
  const commands: string[] = [];

  beforeEach(() => {
    localStorage.clear();
    commands.length = 0;
    mockIPC((cmd) => void commands.push(cmd));
  });
  afterEach(() => clearMocks());

  it("names the current appearance and the next, sets nothing by being shown, and switches on a press", async () => {
    const toggle = mount(AppearanceToggle);
    expect(toggle.attributes("aria-label")).toBe("Appearance: System. Switch to Light.");
    expect(commands).toEqual([]);

    await toggle.trigger("click");
    await flushPromises();

    expect(toggle.attributes("aria-label")).toBe("Appearance: Light. Switch to Dark.");
    expect(commands).toEqual(["plugin:app|set_app_theme"]);
  });

  it("starts from the stored choice", () => {
    localStorage.setItem("library.appearance", "dark");
    expect(mount(AppearanceToggle).attributes("aria-label")).toBe("Appearance: Dark. Switch to System.");
  });

});
