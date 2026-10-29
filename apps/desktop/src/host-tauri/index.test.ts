import { BaseDirectory } from "@tauri-apps/api/path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "./audit.ts";
import { createTauriHost, tauriPaths } from "./index.ts";

afterEach(() => clearMocks());

describe("host-tauri", () => {
  const log = createAuditLog();
  const host = createTauriHost({ home: "/Users/x", appData: "/Users/x/Library/Application Support/l" }, log);

  it("takes home and app data from the path plugin", async () => {
    const dirs: Record<number, string> = { [BaseDirectory.Home]: "/Users/x", [BaseDirectory.AppData]: "/Users/x/Library/Application Support/com.x" };
    mockIPC((cmd, payload) => (cmd === "plugin:path|resolve_directory" ? dirs[(payload as { directory: number }).directory] : undefined));
    expect(await tauriPaths()).toEqual({ home: "/Users/x", appData: "/Users/x/Library/Application Support/com.x" });
  });

  it("hashes with SHA-256 as hex", async () => {
    expect(await host.sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("audits into the log it was given", () => {
    host.audit({ kind: "fs", op: "delete", path: "/Users/x/.claude/skills/a" });
    expect(log.events().at(-1)).toEqual({ kind: "fs", op: "delete", path: "/Users/x/.claude/skills/a" });
  });
});
