// An installed copy on its entry page: Send edits back on the drifted copy (a real PR on the demo repo, closed
// after), then Remove.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { demoRepo } from "@loadout/sandbox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshApp, press, sees } from "./app.ts";
import { chapter } from "./recording.ts";
import { flowsToken } from "./token.ts";

/** The branches Send edits back pushes for code-review. */
const ours = "library/update-code-review-";

/** The demo repo's REST API, as the flows' token: the same account the app opens the PR as. */
async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { accessToken } = JSON.parse(flowsToken()) as { accessToken: string };
  const res = await fetch(`https://api.github.com/repos/${demoRepo.replace("https://github.com/", "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const openPulls = () => github<{ number: number; head: { ref: string } }[]>("GET", "/pulls?state=open&per_page=100");

/**
 * Closes every open PR from a code-review branch and deletes every such branch, PR or not: what this flow left
 * on the demo repo, or an earlier run that stopped between pushing and opening its PR.
 */
async function sweep(): Promise<void> {
  for (const pr of (await openPulls()).filter((p) => p.head.ref.startsWith(ours))) await github("PATCH", `/pulls/${pr.number}`, { state: "closed" });
  const refs = await github<{ ref: string }[]>("GET", `/git/matching-refs/heads/${ours}`);
  for (const { ref } of refs) await github("DELETE", `/git/${ref}`);
}

beforeAll(sweep);
afterEach(sweep);

describe("an installed copy on its entry page", () => {
  it("sends code-review's edits back as a pull request, then removes the copy", async () => {
    const app = await freshApp();
    const b = app.browser;
    const copy = join(app.home, ".claude/skills/code-review");

    await chapter(b, "Send your edits back", "An edited copy becomes a pull request on its source");
    await press(b, "Open code-review");
    await sees(b, "edited locally");

    await press(b, "Send edits back");
    await sees(b, "+End with a one-line verdict: ship, fix first, or discuss.");
    await press(b, "Push and open a pull request");
    await sees(b, "Pull request opened.", 60_000);
    const branch = /From (library\/update-code-review-\S+)\./.exec(await b.$("body").getText())?.[1];
    expect((await openPulls()).filter((p) => p.head.ref === branch)).toHaveLength(1);

    await chapter(b, "Remove a copy", "The catalog entry stays, so it can come back");
    await press(b, "Remove");
    await sees(b, "Delete the installed copy of code-review?");
    await press(b, "Delete");
    await b.waitUntil(async () => !existsSync(copy), { timeout: 15_000, timeoutMsg: "the copy's files are still there" });
  });
});
