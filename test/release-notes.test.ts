// How a release reads on GitHub (R.03). A category naming a label the repo doesn't have silently stays empty,
// so the repo's labels are listed here; when one is added or renamed on GitHub, change this list too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_LABELS = [
  "accessibility",
  "bug",
  "chore",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "skip-changelog",
  "wontfix",
];

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");

interface ReleaseConfig {
  changelog: { exclude: { labels: string[] }; categories: { title: string; labels: string[] }[] };
}

describe("release notes", () => {
  const { changelog } = parse(read(".github/release.yml")) as ReleaseConfig;

  it("groups by labels the repo defines, leaves out skip-changelog, and keeps unlabelled PRs", () => {
    expect(changelog.categories.map((c) => c.title)).toEqual(["Features", "Fixes", "Docs and chores", "Other changes"]);
    expect(changelog.categories.at(-1)!.labels).toEqual(["*"]);
    expect(changelog.exclude.labels).toEqual(["skip-changelog"]);
    for (const label of [...changelog.categories.flatMap((c) => c.labels), ...changelog.exclude.labels].filter((l) => l !== "*")) {
      expect(REPO_LABELS, label).toContain(label);
    }
  });

  it("files bug reports under a label the repo defines", () => {
    const form = parse(read(".github/ISSUE_TEMPLATE/bug_report.yml")) as { labels: string[]; body: { id: string }[] };
    for (const label of form.labels) expect(REPO_LABELS, label).toContain(label);
    expect(form.body.map((field) => field.id)).toEqual(expect.arrayContaining(["version", "doctor"]));
  });

  it("names the assets the release workflow uploads, once tauri-action fills in the version", () => {
    // tauri-action replaces __VERSION__ in the body with the app's version.
    const summary = read(".github/release-summary.md").replace(/__VERSION__/g, "0.1.0");
    expect(summary).toContain("`Loadout_0.1.0_aarch64.dmg`");
    expect(summary).toContain("shasum -a 256 -c Loadout_0.1.0_aarch64.dmg.sha256");
    expect(summary).toContain("brew install --cask j-hernandezinzunza/tap/loadout");
  });
});
