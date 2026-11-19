// Debug profiles (M16.09): a profile's home gets its own login keychain, made its default there, and the
// real user's keychain settings are left alone.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initProfile, unlockProfile } from "../tools/profile.ts";

const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "loadout-profile-"))), "demo");
afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const security = (args: string[], home?: string) =>
  execFileSync("security", args, { encoding: "utf8", env: home ? { ...process.env, HOME: home } : process.env }).trim();

describe("tools/profile.ts", () => {
  it("makes the profile's own default keychain and leaves the real one alone", () => {
    const before = { default: security(["default-keychain"]), list: security(["list-keychains"]) };

    const p = initProfile(dir);
    expect(security(["default-keychain"], p.home)).toBe(`"${p.keychain}"`);
    expect(security(["list-keychains"], p.home)).toContain(p.keychain);
    expect(statSync(p.password).mode & 0o777).toBe(0o600);
    expect(() => unlockProfile(dir)).not.toThrow();

    expect({ default: security(["default-keychain"]), list: security(["list-keychains"]) }).toEqual(before);
  });

  it("leaves a profile already made as it is", () => {
    const p = initProfile(dir);
    const password = readFileSync(p.password, "utf8");
    initProfile(dir);
    expect(readFileSync(p.password, "utf8")).toBe(password);
  });
});
