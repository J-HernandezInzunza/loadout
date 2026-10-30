// The tap update (R.05): on a published release that isn't a pre-release, check the .dmg against its .sha256
// and point the cask at it. The fixture is a copy of the tap's Casks/loadout.rb.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bumpCask } from "../tools/bump-cask.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cask = readFileSync(join(root, "test/fixtures/loadout.rb"), "utf8");
const SHA = "a".repeat(64);

interface Step { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
const tap = parse(readFileSync(join(root, ".github/workflows/tap.yml"), "utf8")) as {
  on: unknown;
  permissions: unknown;
  jobs: { cask: { if: string; environment: string; steps: Step[] } };
};
const { cask: job } = tap.jobs;
const step = (name: string) => job.steps.find((s) => s.name === name)!;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bump-cask", () => {
  it("rewrites the version and sha256 lines and nothing else", () => {
    const bumped = bumpCask(cask, "0.2.0", SHA);
    const before = cask.split("\n");
    const changed = bumped.split("\n").flatMap((line, i) => (line === before[i] ? [] : [line]));
    expect(changed).toEqual(['  version "0.2.0"', `  sha256 "${SHA}"`]);
    // The url follows the version through #{version}.
    expect(bumped).toContain('url "https://github.com/J-HernandezInzunza/loadout/releases/download/v#{version}/Loadout_#{version}_aarch64.dmg"');
  });

  it("links its caveats to a README heading that exists", () => {
    const anchor = /loadout#([a-z0-9-]+)/.exec(cask)![1];
    const headings = readFileSync(join(root, "README.md"), "utf8").match(/^#+ .+$/gm)!;
    // GitHub's anchor: lower case, punctuation dropped, spaces to hyphens.
    const anchors = headings.map((h) => h.replace(/^#+ /, "").toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
    expect(anchors).toContain(anchor);
  });

  it("refuses a pre-release, a malformed checksum, and a cask it can't read", () => {
    expect(() => bumpCask(cask, "0.2.0-rc.1", SHA)).toThrow("not a release version: 0.2.0-rc.1");
    expect(() => bumpCask(cask, "v0.2.0", SHA)).toThrow("not a release version");
    expect(() => bumpCask(cask, "0.2.0", SHA.toUpperCase())).toThrow("not a SHA-256");
    expect(() => bumpCask(cask, "0.2.0", "abc")).toThrow("not a SHA-256");
    expect(() => bumpCask(cask.replace(/^ {2}sha256 .*$/m, ""), "0.2.0", SHA)).toThrow("expected one sha256 line in the cask, found 0");
    expect(() => bumpCask(cask + '  version "9.9.9"\n', "0.2.0", SHA)).toThrow("expected one version line in the cask, found 2");
  });
});

describe("tap workflow", () => {
  it("runs on a published release, skips pre-releases, and holds its token in the release environment", () => {
    expect(tap.on).toEqual({ release: { types: ["published"] } });
    expect(tap.permissions).toEqual({ contents: "read" });
    expect(job.if).toBe("${{ !github.event.release.prerelease }}");
    expect(job.environment).toBe("release");
    expect(job.steps[0]!.name).toBe("Refuse to run without the tap token");
    const tapCheckout = job.steps.find((s) => s.with?.repository === "J-HernandezInzunza/homebrew-tap")!;
    expect(tapCheckout.with).toMatchObject({ token: "${{ secrets.TAP_TOKEN }}", path: "tap" });
    expect(step("Point the cask at the release and push").run).toContain('node tools/bump-cask.ts tap/Casks/loadout.rb "$VERSION" "$SHA256"');
  });

  it("stops without the tap token", () => {
    const guard = spawnSync("bash", ["-eo", "pipefail", "-c", step("Refuse to run without the tap token").run!], { env: { PATH: process.env.PATH! }, encoding: "utf8" });
    expect(guard.status).toBe(1);
    expect(guard.stdout).toContain("::error::the release environment is missing TAP_TOKEN");
  });

  /** Runs the download step in a temp dir, with gh standing in: it "downloads" the given .dmg and .sha256. */
  function download(dmg: string, sha256File: string) {
    const dir = mkdtempSync(join(tmpdir(), "loadout-tap-"));
    temps.push(dir);
    const assets = join(dir, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "Loadout_0.2.0_aarch64.dmg"), dmg);
    writeFileSync(join(assets, "Loadout_0.2.0_aarch64.dmg.sha256"), sha256File);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/bash\necho "$@" > "${join(dir, "gh-args")}"\ncp "${assets}"/* download/\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const output = join(dir, "output");
    writeFileSync(output, "");
    const run = spawnSync("bash", ["-eo", "pipefail", "-c", step("Download the .dmg and check it against its .sha256").run!], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, TAG: "v0.2.0", GITHUB_REPOSITORY: "o/loadout", GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return { status: run.status, out: run.stdout + run.stderr, output: readFileSync(output, "utf8"), ghArgs: readFileSync(join(dir, "gh-args"), "utf8").trim() };
  }

  const sha256Of = (text: string) => spawnSync("shasum", ["-a", "256"], { input: text, encoding: "utf8" }).stdout.split(" ")[0]!;

  it("downloads the tag's .dmg and .sha256 and hands on the version and the checksum they agree on", () => {
    const sha = sha256Of("disk image");
    const ran = download("disk image", `${sha}  Loadout_0.2.0_aarch64.dmg\n`);
    expect(ran.status).toBe(0);
    expect(ran.ghArgs).toBe("release download v0.2.0 --repo o/loadout --dir download --pattern Loadout_0.2.0_aarch64.dmg --pattern Loadout_0.2.0_aarch64.dmg.sha256");
    expect(ran.output).toBe(`version=0.2.0\nsha256=${sha}\n`);
  });

  it("stops when the .dmg doesn't match its .sha256", () => {
    const ran = download("a different disk image", `${sha256Of("disk image")}  Loadout_0.2.0_aarch64.dmg\n`);
    expect(ran.status).not.toBe(0);
    expect(ran.out).toContain("FAILED");
    expect(ran.output).toBe("");
  });
});
