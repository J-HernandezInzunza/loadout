// The machine browser mode shows (M16.03): two catalogs and a copy in each state the app draws, built
// through the real core so receipts, settings and config are what the app would have written. Names
// and descriptions read as real content, since recordings show them.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLibrary, type CoreError, type Result } from "@loadout/core";
import type { ApiStub } from "./apiStub.ts";
import { createGitHarness } from "./git.ts";
import type { Sandbox } from "./sandbox.ts";

/** The GitHub account the demo is signed in as. */
export const demoLogin = "acme-dev";

interface Seed {
  type: "skill" | "agent" | "prompt";
  name: string;
  description: string;
  body: string;
}

const skill = (name: string, description: string, body: string): Seed => ({ type: "skill", name, description, body });

const personal: Seed[] = [
  skill(
    "commit-message",
    "Write a commit message from the staged diff",
    "Read `git diff --cached`. Write a subject under 60 characters in the imperative mood, then one bullet per file that changed.",
  ),
  skill(
    "explain-errors",
    "Explain a stack trace in plain words and point at the line to fix",
    "Find the first frame in this repository's code. Say what failed there, why, and the smallest change that fixes it.",
  ),
  { type: "prompt", name: "standup", description: "Draft today's standup from yesterday's commits", body: "List what I committed since yesterday morning, grouped by branch, as three short bullets: done, doing, blocked." },
];

const team: Seed[] = [
  skill(
    "code-review",
    "Review the current diff for bugs, missing tests and unclear names",
    "Read the diff against the base branch. Report bugs first, then missing tests, then naming. Quote the line for each finding.",
  ),
  skill(
    "release-notes",
    "Turn merged pull requests into release notes grouped by area",
    "List the pull requests merged since the last tag. Group them by the area they touch and write one line each for a user, not a developer.",
  ),
  skill(
    "test-first",
    "Write a failing test that pins a bug before touching the fix",
    "Reproduce the bug in a test that fails for the reason reported. Run it, show the failure, and only then change the code.",
  ),
  skill(
    "pr-description",
    "Describe a branch for review with what changed, why, and how to check it",
    "Summarise the branch's commits as What changed, Why, and How to test. Link the ticket if the branch name has one.",
  ),
  skill(
    "commit-message",
    "Write a commit message in the team's format, with the ticket key",
    "Start the subject with the ticket key from the branch name. Keep it under 72 characters and explain the why in the body.",
  ),
  {
    type: "agent",
    name: "security-reviewer",
    description: "Checks a change for secrets, injection and unsafe defaults",
    body: "You review diffs for security problems only: committed secrets, unescaped input reaching a shell or a query, and defaults that open access.",
  },
];

const skillsRepo = "https://github.com/acme/skills";

/** Where a seed's source lives, relative to its repo or catalog folder. */
const sourcePath = (s: Seed) => (s.type === "skill" ? `skills/${s.name}/SKILL.md` : `${s.type}s/${s.name}.md`);

const fileText = (s: Seed, body = s.body) =>
  s.type === "prompt" ? `${body}\n` : `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${body}\n`;

function catalogYaml(seeds: Seed[], source: (s: Seed) => string): string {
  const block = (type: Seed["type"]) => {
    const items = seeds.filter((s) => s.type === type);
    return `  ${type}s:\n${items.map((s) => `    - name: ${s.name}\n      description: ${s.description}\n      source: ${source(s)}\n`).join("")}`;
  };
  return `library:\n${block("skill")}${block("agent")}${block("prompt")}`;
}

function value<T, E extends CoreError>(step: string, r: Result<T, E>): T {
  if (!r.ok) throw new Error(`seedDemo: ${step}: ${r.error.code}: ${r.error.message}`);
  return r.value;
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/**
 * Seeds an empty sandbox: a local `personal` catalog over a PR-mode `team` catalog on
 * bitbucket.org/acme/catalog, whose sources live on github.com/acme/skills. Installed through the core,
 * then: `code-review` edited (drifted), `pr-description` copied in by hand (unmanaged), `release-notes`'s
 * source moved ahead (stale), `explain-errors` switched off, `commit-message` pinned to `team`, and GitHub
 * connected as {@link demoLogin} through the stub. `test-first` stays not installed.
 */
export async function seedDemo(sandbox: Sandbox, stub: ApiStub): Promise<void> {
  const { home } = sandbox.host.paths;
  const git = createGitHarness(sandbox);

  const sources = git.createRepo("github.com", "acme/skills");
  sources.commit(Object.fromEntries(team.map((s) => [sourcePath(s), fileText(s)])), { message: "Add the team's skills" });
  git.createRepo("bitbucket.org", "acme/catalog").commit(
    { "library.yaml": catalogYaml(team, (s) => `${skillsRepo}/blob/main/${sourcePath(s)}`) },
    { message: "Add the team catalog" },
  );
  const personalDir = join(home, "catalog");
  for (const s of personal) await put(join(personalDir, sourcePath(s)), fileText(s));
  await put(join(personalDir, "library.yaml"), catalogYaml(personal, (s) => `~/catalog/${sourcePath(s)}`));

  const library = createLibrary(sandbox.host, { apiBases: stub.bases });
  const register = async (req: Parameters<typeof library.planAddCatalog>[0]) =>
    value(`register ${req.id}`, await library.applyAddCatalog(value(`plan ${req.id}`, await library.planAddCatalog(req))));
  await register({ kind: "local", id: "personal", path: personalDir, position: "last" });
  await register({ kind: "remote", id: "team", repo: "https://bitbucket.org/acme/catalog.git", protected: true, position: "last" });

  const plan = value("plan install", await library.planInstall({ names: ["code-review", "release-notes", "security-reviewer", "standup", "explain-errors"] }));
  const report = value("install", await library.applyInstall(plan));
  if (report.stopped) throw new Error(`seedDemo: install stopped at ${report.stopped.name}: ${report.stopped.reason}`);

  const teamSeed = (name: string) => team.find((s) => s.name === name)!;
  const review = teamSeed("code-review");
  await put(join(home, ".claude", "skills", review.name, "SKILL.md"), fileText(review, `${review.body}\nEnd with a one-line verdict: ship, fix first, or discuss.`));
  const byHand = teamSeed("pr-description");
  await put(join(home, ".claude", "skills", byHand.name, "SKILL.md"), fileText(byHand));
  const notes = teamSeed("release-notes");
  sources.commit({ [sourcePath(notes)]: fileText(notes, `${notes.body}\nPut breaking changes first, under their own heading.`) }, { message: "release-notes: breaking changes first" });

  value("switch off", await library.setSkillState(["explain-errors"], "off"));
  value("pin", await library.applyPin(value("plan pin", await library.planPin({ name: "commit-message", catalog: "team" })), { switchInstalled: false }));

  stub.addToken("github", "demo-token", demoLogin, ["repo", "read:org"]);
  value("connect", await library.connect("github", { accessToken: "demo-token" }));
}
