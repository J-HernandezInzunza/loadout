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

  it("rejects secrets and http calls until M4", async () => {
    await expect(host.secrets.get("github.com")).rejects.toThrow("host-tauri: secrets.get is not implemented yet (M4)");
    await expect(host.secrets.set("github.com", "t")).rejects.toThrow("secrets.set is not implemented yet");
    await expect(host.secrets.delete("github.com")).rejects.toThrow("secrets.delete is not implemented yet");
    await expect(host.http.request({ method: "GET", url: "https://api.github.com/user" })).rejects.toThrow(
      "host-tauri: http.request is not implemented yet (M4)",
    );
  });

  it("carries the paths it was given", () => {
    expect(host.paths.home).toBe("/Users/x");
  });
});
