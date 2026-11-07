// The `loadout` command shipped inside the app: `loadout run <name>` starts Claude Code with that loadout's
// folder added. Each test runs the script under a temp HOME with a stand-in `claude` that prints its arguments.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const tauriDir = join(root, "apps/desktop/src-tauri");
const script = join(tauriDir, "resources/bin/loadout");
const tauriConf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")) as {
  identifier: string;
  bundle: { resources?: Record<string, string> };
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "loadout-command-"));
  temps.push(home);
  const loadouts = join(home, "Library", "Application Support", tauriConf.identifier, "loadouts");
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]\\n' "$a"; done\n`);
  chmodSync(join(bin, "claude"), 0o755);
  /** A loadout's folder; built means it holds a `.claude`, as a build leaves it. */
  const folder = (name: string, built = true) => {
    mkdirSync(join(loadouts, name, built ? ".claude/skills" : ""), { recursive: true });
    return join(loadouts, name);
  };
  const loadout = (args: string[], path = `${bin}:/usr/bin:/bin`) => spawnSync(script, args, { env: { HOME: home, PATH: path }, encoding: "utf8" });
  return { folder, loadout };
}

describe("the loadout command", () => {
  it("is an executable POSIX sh script the app bundles at bin/loadout", () => {
    expect(readFileSync(script, "utf8").split("\n")[0]).toBe("#!/bin/sh");
    expect(statSync(script).mode & 0o111).toBe(0o111);
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
    expect(tauriConf.bundle.resources).toEqual({ "resources/bin/loadout": "bin/loadout" });
  });

  it("run passes every argument after the name to claude unchanged", () => {
    const { folder, loadout } = setup();
    const dir = folder("review");

    const launched = loadout(["run", "review", "-p", "--model", "haiku", "fix the bug", "--", "-x", `it's "here"`]);

    expect(launched.status).toBe(0);
    expect(launched.stdout).toBe([`--add-dir=${dir}`, "-p", "--model", "haiku", "fix the bug", "--", "-x", `it's "here"`].map((a) => `[${a}]\n`).join(""));
    expect(loadout(["run", "review"]).stdout).toBe(`[--add-dir=${dir}]\n`);
  });

  it("list prints the loadouts that are built, by name", () => {
    const { folder, loadout } = setup();
    expect(loadout(["list"])).toMatchObject({ status: 0, stdout: "" });
    folder("review");
    folder("docs");
    folder("empty", false);

    expect(loadout(["list"])).toMatchObject({ status: 0, stdout: "docs\nreview\n" });
  });

  it("prints usage for --help, and as an error with no command, an unknown one or no name", () => {
    const { loadout } = setup();
    expect(loadout(["--help"])).toMatchObject({ status: 0, stdout: expect.stringContaining("loadout run <name>") });
    for (const args of [[], ["launch"], ["run"]]) {
      expect(loadout(args)).toMatchObject({ status: 2, stdout: "", stderr: expect.stringContaining("loadout run <name>") });
    }
  });

  it("refuses an unknown or unbuilt name and says to open Loadout", () => {
    const { folder, loadout } = setup();
    folder("empty", false);
    for (const name of ["nope", "../review", "Review"]) {
      expect(loadout(["run", name])).toMatchObject({ status: 1, stdout: "", stderr: expect.stringContaining("Loadout") });
    }
    expect(loadout(["run", "empty"])).toMatchObject({ status: 1, stdout: "", stderr: expect.stringMatching(/hasn't been built.*Loadout/) });
  });

  it("says so when claude isn't on PATH", () => {
    const { folder, loadout } = setup();
    folder("review");
    expect(existsSync("/usr/bin/claude") || existsSync("/bin/claude")).toBe(false);
    expect(loadout(["run", "review"], "/usr/bin:/bin")).toMatchObject({ status: 127, stdout: "", stderr: expect.stringContaining("claude isn't on your PATH") });
  });
});
