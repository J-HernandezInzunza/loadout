import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import { installDirs } from "./scan.ts";
import { attribute, browserOS, npxSkills, type Attribution, type Detector } from "./tools.ts";

async function put(path: string, text = "x\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function setup() {
  const sb = await createSandbox();
  const home = sb.host.paths.home;
  const skills = installDirs(home).skill;
  const agents = join(home, ".agents");
  await mkdir(skills, { recursive: true });
  /** A link at `skills/<name>` to `target`, as a detector is handed it after the scan resolved it. */
  const linked = async (name: string, target: string) => {
    await symlink(target, join(skills, name));
    return { type: "skill" as const, path: join(skills, name), link: { target, kind: "dir" as const } };
  };
  return { sb, home, skills, agents, linked };
}

const unknown = { source: null, installedAt: null, updatedAt: null };

describe("npx skills", () => {
  it("names a link into ~/.agents/skills, with its lock's details keyed by the target's folder", async () => {
    const { sb, agents, linked } = await setup();
    await put(join(agents, "skills/find-skills/SKILL.md"));
    await put(join(agents, ".skill-lock.json"), await readFile(join(import.meta.dirname, "../../test/fixtures/skill-lock-v3.json"), "utf8"));
    expect(await npxSkills(sb.host, await linked("finder", join(agents, "skills/find-skills")))).toEqual({
      tool: "npx skills",
      source: "vercel-labs/skills",
      installedAt: "2026-09-25T17:35:14.235Z",
      updatedAt: "2026-09-25T17:35:14.235Z",
    });
  });

  it("still names it, without details, when the lock is missing, unreadable, another version or lacks the skill", async () => {
    const { sb, agents, linked } = await setup();
    await put(join(agents, "skills/s/SKILL.md"));
    const item = await linked("s", join(agents, "skills/s"));
    const none = { tool: "npx skills", ...unknown };

    expect(await npxSkills(sb.host, item)).toEqual(none);
    for (const lock of ["{", JSON.stringify({ version: 4, skills: { s: { source: "a/b" } } }), JSON.stringify({ version: 3, skills: { t: { source: "a/b" } } })]) {
      await put(join(agents, ".skill-lock.json"), lock);
      expect(await npxSkills(sb.host, item)).toEqual(none);
    }
    await put(join(agents, ".skill-lock.json"), JSON.stringify({ version: 3, skills: { s: { source: 7, installedAt: "2026-01-01" } } }));
    expect(await npxSkills(sb.host, item)).toEqual({ ...none, installedAt: "2026-01-01" });
  });

  it("passes on a link elsewhere, a real folder, a broken link and anything but a skill", async () => {
    const { sb, home, skills, agents, linked } = await setup();
    await put(join(home, "elsewhere/SKILL.md"));
    await put(join(agents, "skills/s/SKILL.md"));
    expect(await npxSkills(sb.host, await linked("other", join(home, "elsewhere")))).toBeNull();
    expect(await npxSkills(sb.host, { type: "skill", path: join(skills, "real") })).toBeNull();
    expect(await npxSkills(sb.host, { type: "skill", path: join(skills, "gone"), link: { target: null, broken: true } })).toBeNull();
    expect(await npxSkills(sb.host, { type: "prompt", path: join(skills, "s"), link: { target: join(agents, "skills/s"), kind: "dir" } })).toBeNull();
  });
});

describe("BrowserOS", () => {
  it("names a real skill folder holding its marker, and passes on anything else", async () => {
    const { sb, skills, home, linked } = await setup();
    await put(join(skills, "neo/SKILL.md"));
    await put(join(skills, "neo/.browserclaw-managed.json"), "{}");
    await put(join(skills, "plain/SKILL.md"));
    await put(join(home, "marked/.browserclaw-managed.json"), "{}");
    expect(await browserOS(sb.host, { type: "skill", path: join(skills, "neo") })).toEqual({ tool: "BrowserOS", ...unknown });
    expect(await browserOS(sb.host, { type: "skill", path: join(skills, "plain") })).toBeNull();
    // A link is never looked inside, even to a folder holding the marker.
    expect(await browserOS(sb.host, await linked("via-link", join(home, "marked")))).toBeNull();
  });
});

describe("attribute", () => {
  it("asks each detector in order and takes the first that recognizes the item", async () => {
    const { sb } = await setup();
    const asked: string[] = [];
    const named = (tool: string, recognizes: boolean): Detector => async () => {
      asked.push(tool);
      return recognizes ? ({ tool, ...unknown } satisfies Attribution) : null;
    };
    const item = { type: "skill" as const, path: "/x" };
    expect(await attribute(sb.host, item, [named("a", false), named("b", true), named("c", true)])).toEqual({ tool: "b", ...unknown });
    expect(asked).toEqual(["a", "b"]);
    expect(await attribute(sb.host, item, [named("a", false)])).toBeUndefined();
  });
});
