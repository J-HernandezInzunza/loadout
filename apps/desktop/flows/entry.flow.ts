// An installed copy on its entry page: Send edits back on the drifted copy (a real PR on the demo repo, closed
// after), then Remove.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { demoRepo } from "@loadout/sandbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshProfile, press, sees, type RunningApp } from "./app.ts";
import { flowsToken } from "./token.ts";

const slug = demoRepo.replace("https://github.com/", "");

/** Closes the PRs Send edits back opened for code-review, and deletes their branches, with the owner's gh. */
function closeCodeReviewPrs(): number {
  const open = JSON.parse(execFileSync("gh", ["pr", "list", "--repo", slug, "--state", "open", "--json", "number,headRefName"], { encoding: "utf8" })) as { number: number; headRefName: string }[];
  const ours = open.filter((pr) => pr.headRefName.startsWith("library/update-code-review-"));
  for (const pr of ours) execFileSync("gh", ["pr", "close", String(pr.number), "--repo", slug, "--delete-branch"], { stdio: "ignore" });
  return ours.length;
}

let token: string;
let app: RunningApp | undefined;
let profile: Awaited<ReturnType<typeof freshProfile>> | undefined;
beforeAll(() => {
  token = flowsToken();
});
afterEach(async () => {
  await app?.close();
  profile?.dispose();
  closeCodeReviewPrs();
});

describe("an installed copy on its entry page", () => {
  it("sends code-review's edits back as a pull request, then removes the copy", async () => {
    profile = await freshProfile(token);
    app = await profile.open();
    const b = app.browser;
    const copy = join(app.home, ".claude/skills/code-review");

    await press(b, "Open code-review");
    await sees(b, "edited locally");

    await press(b, "Send edits back");
    await sees(b, "+End with a one-line verdict: ship, fix first, or discuss.");
    await press(b, "Push and open a pull request");
    await sees(b, "Pull request opened.", 60_000);
    expect(closeCodeReviewPrs()).toBe(1);

    await press(b, "Remove");
    await sees(b, "Delete the installed copy of code-review?");
    await press(b, "Delete");
    await b.waitUntil(async () => !existsSync(copy), { timeout: 15_000, timeoutMsg: "the copy's files are still there" });
  });
});
