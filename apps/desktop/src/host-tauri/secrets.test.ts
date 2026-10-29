import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { createTauriSecrets } from "./secrets.ts";

afterEach(() => clearMocks());

describe("host-tauri secrets", () => {
  it("stores, reads and deletes through the Keychain commands", async () => {
    const store = new Map<string, string>();
    const calls: [string, unknown][] = [];
    mockIPC((cmd, payload) => {
      const { key, value } = payload as { key: string; value?: string };
      calls.push([cmd, payload]);
      if (cmd === "secret_get") return store.get(key) ?? null;
      if (cmd === "secret_set") return void store.set(key, value!);
      if (cmd === "secret_delete") return void store.delete(key);
      throw new Error(`unexpected command ${cmd}`);
    });
    const secrets = createTauriSecrets();
    expect(await secrets.get("github")).toBeNull();
    await secrets.set("github", '{"accessToken":"t"}');
    expect(await secrets.get("github")).toBe('{"accessToken":"t"}');
    await secrets.delete("github");
    expect(await secrets.get("github")).toBeNull();
    expect(calls.map(([cmd]) => cmd)).toEqual(["secret_get", "secret_set", "secret_get", "secret_delete", "secret_get"]);
    expect(calls[1]).toEqual(["secret_set", { key: "github", value: '{"accessToken":"t"}' }]);
  });

  it("rejects with an Error when the Keychain fails", async () => {
    mockIPC(() => Promise.reject("Platform secure storage failure: locked"));
    await expect(createTauriSecrets().get("bitbucket")).rejects.toThrow("secret_get: Platform secure storage failure: locked");
  });
});
