// The Tauri capability file is the app's permission surface (architecture.md §2.4, §6): the shell may
// spawn only git (gh was dropped for the host APIs, §5.5), the fs scope must keep its denies for
// secrets under $HOME and reach nothing past $HOME and $APPDATA, and the app's own commands are few.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../apps/desktop/src-tauri/capabilities/", import.meta.url));

type Permission = string | { identifier: string; allow?: Record<string, unknown>[]; deny?: Record<string, unknown>[] };
const permissions: Permission[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => (JSON.parse(readFileSync(dir + f, "utf8")) as { permissions: Permission[] }).permissions);

const scoped = (prefix: string) =>
  permissions.filter((p): p is Exclude<Permission, string> => typeof p !== "string" && p.identifier.startsWith(prefix));

describe("capabilities", () => {
  it("lets the shell run only git, with no sidecars", () => {
    const shell = scoped("shell:");
    expect(shell.length).toBeGreaterThan(0);
    for (const p of shell) {
      for (const entry of p.allow ?? []) {
        expect(entry.cmd).toBe("git");
        expect(entry.name).toBe(entry.cmd);
        expect(entry.sidecar ?? false).toBe(false);
      }
    }
    expect(permissions).not.toContain("shell:default");
    expect(permissions.filter((p) => typeof p === "string" && p.startsWith("shell:allow-open"))).toEqual([]);
  });

  it("scopes fs to $HOME and $APPDATA and denies secret stores", () => {
    const fsScope = scoped("fs:scope");
    const allow = fsScope.flatMap((p) => p.allow ?? []).map((e) => e.path);
    const deny = fsScope.flatMap((p) => p.deny ?? []).map((e) => e.path);
    // A `/**` glob does not match the folder itself, and the app must create $APPDATA on first launch.
    expect(allow.sort()).toEqual(["$APPDATA", "$APPDATA/**", "$HOME/**"]);
    expect(deny).toEqual(
      expect.arrayContaining([
        "$HOME/.ssh/**",
        "$HOME/Library/Keychains/**",
        "$HOME/.gnupg/**",
        // Credential stores reachable once dot-directories are in scope (QUESTIONS.md Q3).
        "$HOME/.config/gh/**",
        "$HOME/.aws/**",
        "$HOME/.netrc",
        "$HOME/.docker/**",
        "$HOME/.kube/**",
      ]),
    );
  });

  it("lets globs match dot-components, or $HOME/** would exclude ~/.claude", () => {
    const conf = JSON.parse(readFileSync(dir + "../tauri.conf.json", "utf8"));
    expect(conf.plugins?.fs?.requireLiteralLeadingDot).toBe(false);
  });

  it("grants only the app commands no plugin covers", () => {
    // App permissions carry no plugin prefix; build.rs's app manifest denies any command not granted here.
    const app = permissions.filter((p): p is string => typeof p === "string" && !p.includes(":"));
    expect(app).toEqual(["allow-real-path"]);
  });

  it("never grants fs permissions with their own wider scope", () => {
    for (const p of scoped("fs:")) {
      if (p.identifier === "fs:scope") continue;
      expect(p.allow).toBeUndefined();
    }
  });
});
