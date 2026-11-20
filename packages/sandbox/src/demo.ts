// The machine a debug profile shows (M16.03, M16.10): two catalogs and a copy in each state the app draws,
// built through the real core so receipts, settings and config are what the app would have written. Names
// and descriptions read as real content, since recordings show them.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLibrary, type CoreError, type Host, type Result } from "@loadout/core";

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

/** The public repo holding the demo's team catalog and its sources (M16.08). */
export const demoRepo = "https://github.com/J-HernandezInzunza/loadout-demo";

/** `release-notes` as its source moves on, so an installed copy reads "update available". */
const releaseNotesAhead = (body: string) => `${body}\nPut breaking changes first, under their own heading.`;

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

/**
 * The demo repo's files: `main` holds `library.yaml` and every team entry, its sources pointing into the
 * repo itself (`release-notes` on the `demo-stale` branch); `ahead` is the one change from the
 * `demo-stale-v1` tag to `demo-stale-v2`.
 */
export function demoRepoContent(): { main: Record<string, string>; ahead: Record<string, string> } {
  const notes = team.find((s) => s.name === "release-notes")!;
  const branchOf = (s: Seed) => (s === notes ? "demo-stale" : "main");
  return {
    main: {
      "README.md":
        "# loadout-demo\n\nThe team catalog that [Loadout](https://github.com/J-HernandezInzunza/loadout)'s debug profiles and recordings use. " +
        "Seeding a profile force-pushes the `demo-stale` branch between the `demo-stale-v1` and `demo-stale-v2` tags, and demo flows open and close pull requests here.\n",
      "library.yaml": catalogYaml(team, (s) => `${demoRepo}/blob/${branchOf(s)}/${sourcePath(s)}`),
      ...Object.fromEntries(team.map((s) => [sourcePath(s), fileText(s)])),
    },
    ahead: { [sourcePath(notes)]: fileText(notes, releaseNotesAhead(notes.body)) },
  };
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
 * Moves the demo repo's `demo-stale` branch to one of its two tags, from a throwaway bare repo: a force
 * push, with whatever git credentials the host's git has.
 */
async function moveStale(host: Host, repo: string, tag: "demo-stale-v1" | "demo-stale-v2"): Promise<void> {
  const dir = await host.fs.makeTempDir("demo-stale-");
  const git = async (args: string[]) => {
    const r = await host.proc.run("git", args, { cwd: dir });
    if (r.code !== 0) throw new Error(`seedDemo: git ${args[0]}: ${r.stderr.trim()}`);
  };
  try {
    await git(["init", "--quiet", "--bare"]);
    await git(["fetch", "--quiet", "--no-tags", `${repo}.git`, `+refs/tags/${tag}:refs/tags/${tag}`]);
    await git(["push", "--quiet", "--force", `${repo}.git`, `refs/tags/${tag}^{commit}:refs/heads/demo-stale`]);
  } finally {
    await host.fs.remove(dir, { recursive: true });
  }
}

/**
 * Seeds an empty profile through the core: a local `personal` catalog over the PR-mode `team` catalog in
 * the demo repo. Installed, then: `code-review` edited (drifted), `pr-description` copied in by hand
 * (unmanaged), `explain-errors` switched off, `commit-message` pinned to `team`, and `release-notes`
 * installed from `demo-stale` at v1 before the branch moves to v2 (stale). `test-first` stays not installed,
 * and no account is connected: there is no token to give.
 */
export async function seedDemo(host: Host, repo = demoRepo): Promise<void> {
  const { home } = host.paths;
  const personalDir = join(home, "catalog");
  for (const s of personal) await put(join(personalDir, sourcePath(s)), fileText(s));
  await put(join(personalDir, "library.yaml"), catalogYaml(personal, (s) => `~/catalog/${sourcePath(s)}`));

  await moveStale(host, repo, "demo-stale-v1");
  const library = createLibrary(host);
  const register = async (req: Parameters<typeof library.planAddCatalog>[0]) =>
    value(`register ${req.id}`, await library.applyAddCatalog(value(`plan ${req.id}`, await library.planAddCatalog(req))));
  await register({ kind: "local", id: "personal", path: personalDir, position: "last" });
  await register({ kind: "remote", id: "team", repo: `${repo}.git`, protected: true, position: "last" });

  const plan = value("plan install", await library.planInstall({ names: ["code-review", "release-notes", "security-reviewer", "standup", "explain-errors"] }));
  const report = value("install", await library.applyInstall(plan));
  if (report.stopped) throw new Error(`seedDemo: install stopped at ${report.stopped.name}: ${report.stopped.reason}`);

  const teamSeed = (name: string) => team.find((s) => s.name === name)!;
  const review = teamSeed("code-review");
  await put(join(home, ".claude", "skills", review.name, "SKILL.md"), fileText(review, `${review.body}\nEnd with a one-line verdict: ship, fix first, or discuss.`));
  const byHand = teamSeed("pr-description");
  await put(join(home, ".claude", "skills", byHand.name, "SKILL.md"), fileText(byHand));
  await moveStale(host, repo, "demo-stale-v2");

  value("switch off", await library.setSkillState(["explain-errors"], "off"));
  value("pin", await library.applyPin(value("plan pin", await library.planPin({ name: "commit-message", catalog: "team" })), { switchInstalled: false }));
}
