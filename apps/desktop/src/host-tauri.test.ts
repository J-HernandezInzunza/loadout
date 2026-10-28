import { describe, expect, it } from "vitest";
import { createTauriHost } from "./host-tauri.ts";

describe("host-tauri (stub until M4)", () => {
  const host = createTauriHost({ home: "/Users/x", appData: "/Users/x/Library/Application Support/l" });

  it("rejects every fs and proc call with a clear not-implemented error", async () => {
    await expect(host.fs.readText("/x")).rejects.toThrow("host-tauri: fs.readText is not implemented yet (M4)");
    await expect(host.proc.run("git", ["--version"], {})).rejects.toThrow(
      "host-tauri: proc.run is not implemented yet (M4)",
    );
  });

  it("carries the paths it was given", () => {
    expect(host.paths.home).toBe("/Users/x");
  });
});
