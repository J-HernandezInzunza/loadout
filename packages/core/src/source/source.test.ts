import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { accountHostOf, cloneUrls, parseRepoLink, parseSource, remoteWeb } from "./source.ts";

const fixture = loadGolden("source");
const GOLDEN_HOME = fixture.meta.home;

describe("parseSource", () => {
  it.each(fixture.parseSource.map((c) => [JSON.stringify(c.input), c] as const))("FETCH-01: %s", async (_, c) => {
    const { host } = await createSandbox();
    const home = host.paths.home;
    const sandboxed = (s: string) => s.replace(GOLDEN_HOME, home);
    const run = () => {
      const src = parseSource(c.input, home);
      return src.kind === "local" ? src : { ...src, cloneUrls: cloneUrls(src) };
    };
    if ("error" in c) {
      expect(run).toThrow(expect.objectContaining({ code: "INVALID_SOURCE", message: c.error }));
    } else {
      expect(run()).toEqual(c.parsed.kind === "local" ? { ...c.parsed, path: sandboxed(c.parsed.path) } : c.parsed);
    }
  });

  it("FETCH-01: expands ~ against a home with a trailing slash as Python does", () => {
    expect(parseSource("~/x.md", "/h/")).toEqual({ kind: "local", path: "/h/x.md" });
    expect(parseSource("~", "/")).toEqual({ kind: "local", path: "/" });
  });
});

describe("parseRepoLink", () => {
  it.each([
    ["a GitHub repo page", "https://github.com/acme/agentics", { repo: "https://github.com/acme/agentics.git", on: "github", org: "acme", name: "agentics" }],
    ["a GitHub clone URL", "https://github.com/acme/agentics.git", { repo: "https://github.com/acme/agentics.git", on: "github", org: "acme", name: "agentics" }],
    ["a GitHub ssh URL, kept as given", "git@github.com:acme/agentics.git", { repo: "git@github.com:acme/agentics.git", on: "github", org: "acme", name: "agentics" }],
    [
      "a GitHub link to the file",
      "https://github.com/acme/agentics/blob/dev/catalog/library.yaml",
      { repo: "https://github.com/acme/agentics.git", on: "github", org: "acme", name: "agentics", branch: "dev", yamlPath: "catalog/library.yaml" },
    ],
    ["a GitHub tree link", "https://github.com/acme/agentics/tree/main", { repo: "https://github.com/acme/agentics.git", on: "github", org: "acme", name: "agentics", branch: "main" }],
    ["a Bitbucket repo page", "https://bitbucket.org/sedteam/agent-library/", { repo: "https://bitbucket.org/sedteam/agent-library.git", on: "bitbucket", org: "sedteam", name: "agent-library" }],
    [
      "a Bitbucket link to the file",
      "https://bitbucket.org/sedteam/agent-library/src/main/library.yaml",
      { repo: "https://bitbucket.org/sedteam/agent-library.git", on: "bitbucket", org: "sedteam", name: "agent-library", branch: "main", yamlPath: "library.yaml" },
    ],
    [
      "a Bitbucket link at a commit, whose branch is in ?at=",
      "https://bitbucket.org/sedteam/agent-library/src/0123456789ab/library.yaml?at=release",
      { repo: "https://bitbucket.org/sedteam/agent-library.git", on: "bitbucket", org: "sedteam", name: "agent-library", branch: "release", yamlPath: "library.yaml" },
    ],
    ["a Bitbucket https clone URL with a user", "https://jose@bitbucket.org/sedteam/agent-library.git", { repo: "https://bitbucket.org/sedteam/agent-library.git", on: "bitbucket", org: "sedteam", name: "agent-library" }],
    [
      "Bitbucket's new ssh host, kept as given",
      "git@ssh.bitbucket.org:sedteam/agent-library.git",
      { repo: "git@ssh.bitbucket.org:sedteam/agent-library.git", on: "bitbucket", org: "sedteam", name: "agent-library" },
    ],
    ["another host's page", "https://gitlab.com/acme/agentics", { repo: "https://gitlab.com/acme/agentics.git", on: null, org: "acme", name: "agentics" }],
  ] as const)("reads %s", (_, input, expected) => {
    expect(parseRepoLink(input)).toEqual(expected);
  });

  it("is null for what names no repository", () => {
    for (const input of ["", "agentics", "https://github.com/acme", "/Users/dev/catalog/library.yaml"]) expect(parseRepoLink(input)).toBeNull();
  });
});

describe("accountHostOf", () => {
  it("names GitHub and Bitbucket (its SSH host too) for every URL form, and nothing else", () => {
    expect(accountHostOf("git@github.com:o/r.git")).toBe("github");
    expect(accountHostOf("https://github.com/o/r")).toBe("github");
    expect(accountHostOf("ssh://git@bitbucket.org/o/r.git")).toBe("bitbucket");
    expect(accountHostOf("git@ssh.bitbucket.org:o/r.git")).toBe("bitbucket");
    expect(accountHostOf("git@gitlab.com:o/r.git")).toBeNull();
    expect(accountHostOf("/Users/dev/repo")).toBeNull();
  });
});

describe("remoteWeb", () => {
  it.each(fixture.remoteWeb.map((c) => [JSON.stringify(c.input), c] as const))("FETCH-01: %s", (_, c) => {
    expect(remoteWeb(c.input)).toEqual(c.parsed);
  });

  it("reads Bitbucket's new SSH host as Bitbucket, whose web pages stay on bitbucket.org", () => {
    expect(remoteWeb("git@ssh.bitbucket.org:sedteam/agent-library.git")).toEqual(["bitbucket.org", "sedteam", "agent-library"]);
    expect(remoteWeb("ssh://git@ssh.bitbucket.org/sedteam/agent-library.git")).toEqual(["bitbucket.org", "sedteam", "agent-library"]);
  });
});
