import { describe, expect, it } from "vitest";
import { loadGolden } from "../../test/golden.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { cloneUrls, parseSource, remoteWeb } from "./source.ts";

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

describe("remoteWeb", () => {
  it.each(fixture.remoteWeb.map((c) => [JSON.stringify(c.input), c] as const))("FETCH-01: %s", (_, c) => {
    expect(remoteWeb(c.input)).toEqual(c.parsed);
  });

  it("reads Bitbucket's new SSH host as Bitbucket, whose web pages stay on bitbucket.org", () => {
    expect(remoteWeb("git@ssh.bitbucket.org:sedteam/agent-library.git")).toEqual(["bitbucket.org", "sedteam", "agent-library"]);
    expect(remoteWeb("ssh://git@ssh.bitbucket.org/sedteam/agent-library.git")).toEqual(["bitbucket.org", "sedteam", "agent-library"]);
  });
});
