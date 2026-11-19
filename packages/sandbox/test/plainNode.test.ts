import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("plainNode.ts", import.meta.url));

describe("@loadout/sandbox outside Vitest", () => {
  it("creates a sandbox, a remote and the API stub under plain node, then removes them all", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [script]);
    const out = JSON.parse(stdout) as { root: string; head: string; lsRemote: string; stubBase: string; stubStatus: number };

    // Each worked while it was up: the remote answered on its https URL, the stub on its loopback port.
    expect(out.lsRemote).toBe(`${out.head}\trefs/heads/main`);
    expect(out.stubStatus).toBe(401);
    // And the clean-ups removed them: the root is gone and the stub's port refuses connections.
    expect(existsSync(out.root)).toBe(false);
    await expect(fetch(`${out.stubBase}/user`)).rejects.toThrow();
  });
});
