// The release workflow (R.02) can only really run on a pushed tag, so this pins what it must do: the trigger,
// the jobs' order, the environment and permissions, the draft settings, and the shell steps, which run here
// against stand-ins for the runner's environment.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = (name: string) => parse(readFileSync(join(root, ".github/workflows", name), "utf8"));

interface Step { name?: string; uses?: string; id?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { needs?: string; uses?: string; environment?: string; permissions?: Record<string, string>; steps?: Step[] }

const release = workflow("release.yml") as { on: unknown; permissions: unknown; jobs: Record<string, Job> };
const { version, gate, build } = release.jobs as Record<"version" | "gate" | "build", Job>;
const SECRETS = ["LOADOUT_GITHUB_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_ID", "LOADOUT_BITBUCKET_CLIENT_SECRET"];

const step = (job: Job, name: string) => job.steps!.find((s) => s.name === name)!;
const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loadout-release-"));
  temps.push(dir);
  return dir;
};

/** Runs a step's script the way the runner does (bash -e -o pipefail), with only the given variables set. */
function runStep(s: Step, env: Record<string, string>, cwd = root) {
  const done = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", s.run!], {
    cwd,
    env: { PATH: process.env.PATH!, ...env },
    encoding: "utf8",
  });
  return { status: done.status, out: done.stdout + done.stderr };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release workflow", () => {
  it("runs only on a pushed v* tag, read-only unless a job says otherwise", () => {
    expect(release.on).toEqual({ push: { tags: ["v*"] } });
    expect(release.permissions).toEqual({ contents: "read" });
  });

  it("checks the tag, then runs the gate, then builds", () => {
    expect(version.needs).toBeUndefined();
    expect(gate).toMatchObject({ needs: "version", uses: "./.github/workflows/ci.yml" });
    expect(workflow("ci.yml").on).toHaveProperty("workflow_call");
    expect(build.needs).toBe("gate");
  });

  it("refuses a tag that isn't v<version>", () => {
    const check = step(version, "Refuse a tag that isn't v<version>");
    const current = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
    expect(runStep(check, { GITHUB_REF_NAME: `v${current}` }).status).toBe(0);
    for (const tag of [`v${current}-rc.1`, current, "v99.0.0"]) {
      const refused = runStep(check, { GITHUB_REF_NAME: tag });
      expect(refused.status, tag).toBe(1);
      expect(refused.out).toContain(`::error::tag ${tag} doesn't match the version ${current}`);
    }
  });

  it("builds in the release environment, the only job that may write", () => {
    expect(build.environment).toBe("release");
    expect(build.permissions).toEqual({ contents: "write" });
    expect(version.permissions).toBeUndefined();
    expect(gate.permissions).toBeUndefined();
  });

  it("stops before building when a secret is missing", () => {
    const guard = build.steps![0]!;
    expect(guard.name).toBe("Refuse to build without the OAuth clients");
    expect(guard.env).toEqual(Object.fromEntries(SECRETS.map((s) => [s, `\${{ secrets.${s} }}`])));
    const all = Object.fromEntries(SECRETS.map((s) => [s, "x"]));
    expect(runStep(guard, all).status).toBe(0);

    // One unset, one set but empty: both count as missing.
    const refused = runStep(guard, { LOADOUT_GITHUB_CLIENT_ID: "", LOADOUT_BITBUCKET_CLIENT_SECRET: "x" });
    expect(refused.status).toBe(1);
    expect(refused.out).toContain("::error::the release environment is missing: LOADOUT_GITHUB_CLIENT_ID LOADOUT_BITBUCKET_CLIENT_ID");
  });

  it("builds Apple Silicon into a draft with generated notes under the summary, a pre-release for a tag with a -", () => {
    const action = build.steps!.find((s) => s.uses?.startsWith("tauri-apps/tauri-action@"))!;
    expect(action.uses).toBe("tauri-apps/tauri-action@v1");
    expect(action.with).toMatchObject({
      projectPath: "apps/desktop",
      args: "--target aarch64-apple-darwin",
      tagName: "${{ github.ref_name }}",
      releaseBody: "${{ steps.summary.outputs.body }}",
      releaseDraft: true,
      generateReleaseNotes: true,
      prerelease: "${{ contains(github.ref_name, '-') }}",
    });
    for (const s of SECRETS) expect(action.env![s]).toBe(`\${{ secrets.${s} }}`);
    expect(step(build, "Read the release summary").run).toContain("cat .github/release-summary.md");
  });

  it("uploads Loadout_<version>_aarch64.dmg.sha256 to the release, a checksum shasum -c accepts", () => {
    const upload = step(build, "Upload the .dmg's SHA-256");
    const dir = tempDir();
    const bundle = join(dir, "target/aarch64-apple-darwin/release/bundle");
    mkdirSync(join(bundle, "dmg"), { recursive: true });
    writeFileSync(join(bundle, "dmg/Loadout_0.1.0_aarch64.dmg"), "not really a disk image");
    // gh stands in for the upload: it records its arguments.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/bash\necho "$@" > "${join(dir, "gh-args")}"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const artifacts = [join(bundle, "macos/Loadout.app"), join(bundle, "dmg/Loadout_0.1.0_aarch64.dmg")];
    const env = { PATH: `${bin}:${process.env.PATH}`, GITHUB_REF_NAME: "v0.1.0", GITHUB_REPOSITORY: "o/loadout" };

    expect(runStep(upload, { ...env, ARTIFACTS: JSON.stringify(artifacts) }).status).toBe(0);
    expect(readFileSync(join(dir, "gh-args"), "utf8").trim()).toBe("release upload v0.1.0 Loadout_0.1.0_aarch64.dmg.sha256 --repo o/loadout");
    expect(execFileSync("shasum", ["-a", "256", "-c", "Loadout_0.1.0_aarch64.dmg.sha256"], { cwd: join(bundle, "dmg"), encoding: "utf8" })).toBe("Loadout_0.1.0_aarch64.dmg: OK\n");

    const none = runStep(upload, { ...env, ARTIFACTS: JSON.stringify(artifacts.slice(0, 1)) });
    expect(none.status).toBe(1);
    expect(none.out).toContain("::error::expected one .dmg");
  });
});
