// Debug profiles (M16.09): a profile is a home and, beside it, the owner-only file a debug build keeps its
// secrets in instead of the Keychain; only a debug build can be pointed at that file.
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initProfile, profileEnv, setProfileSecret } from "../tools/profile.ts";

const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "loadout-profile-"))), "demo");
afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("tools/profile.ts", () => {
  it("makes the profile's home, and leaves a profile already made as it is", () => {
    const p = initProfile(dir);
    expect(statSync(p.home).isDirectory()).toBe(true);
    setProfileSecret(dir, "github", "t");
    initProfile(dir);
    expect(JSON.parse(readFileSync(p.secrets, "utf8"))).toEqual({ github: "t" });
  });

  it("keeps secrets in an owner-only file beside the home, adding to what's there", () => {
    const p = initProfile(dir);
    setProfileSecret(dir, "github", "{\"accessToken\":\"x\"}");
    setProfileSecret(dir, "bitbucket.org", "b");
    expect(JSON.parse(readFileSync(p.secrets, "utf8"))).toEqual({ github: "{\"accessToken\":\"x\"}", "bitbucket.org": "b" });
    expect(statSync(p.secrets).mode & 0o777).toBe(0o600);
    expect(p.secrets.startsWith(p.home)).toBe(false);
  });

  it("starts the app with a launchd-like environment, the profile's HOME and secrets file, nothing else from the shell", () => {
    const env = profileEnv("/p", { HOME: "/Users/me", USER: "me", SHELL: "/bin/zsh", CLAUDE_CONFIG_DIR: "/Users/me/.claude-x", GIT_DIR: "/x", PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(env).toEqual({ USER: "me", SHELL: "/bin/zsh", HOME: "/p/home", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LOADOUT_PROFILE_SECRETS: "/p/secrets.json" });
  });

  it("reads the secrets file only in debug builds", () => {
    const rs = readFileSync(new URL("../apps/desktop/src-tauri/src/secrets.rs", import.meta.url), "utf8");
    expect(rs).toContain("#[cfg(debug_assertions)]\nmod profile_file {");
    const uses = rs.match(/.*\n.*profile_file::path\(\)/g) ?? [];
    expect(uses).toHaveLength(3);
    for (const use of uses) expect(use).toMatch(/#\[cfg\(debug_assertions\)\]\n/);
  });
});
