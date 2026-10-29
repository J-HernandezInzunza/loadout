import { entryRecord, installedRecord } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import { catalogHue, describePush, installStatus, rowsFor, searchRows, type ListFilter } from "./catalog.ts";

const label = (rows: ReturnType<typeof rowsFor>) => rows.map((r) => `${r.entry.name}@${r.entry.catalog}`);

describe("UI-14: catalog colour", () => {
  it("is a hue by precedence position, so reordering recolours", () => {
    expect([1, 2, 3, 4, 5].map(catalogHue)).toEqual([211, 275, 25, 320, 211]);
  });
});

describe("UI-19: the install badge", () => {
  it("words each state the core read at the destination", () => {
    const badge = (e: Parameters<typeof installStatus>[0]) => Object.values(installStatus(e)).join(" / ");
    expect([
      badge(installedRecord("installed")),
      badge(installedRecord("unmanaged")),
      badge(installedRecord("drifted")),
      badge(installedRecord("stale")),
      badge(entryRecord()),
    ]).toEqual(["installed / installed", "installed outside Loadout / installed", "edited locally / attention", "update available / attention", "not installed / absent"]);
  });

  it("calls a copy that is on the machine but switched off disabled, whatever else is true of it", () => {
    expect(installStatus(installedRecord("drifted", { disabled: true }))).toEqual({ status: "disabled", tone: "disabled" });
  });
});

describe("UI-12: which rows a filter shows", () => {
  const records = [
    entryRecord({ name: "x", catalog: "A", overrides: ["B"] }),
    entryRecord({ name: "lint", catalog: "A" }),
    entryRecord({ name: "x", catalog: "B", overriddenBy: "A" }),
    installedRecord("installed", { name: "off", catalog: "B", disabled: true }),
    installedRecord("installed", { type: "prompt", name: "style", catalog: "A" }),
  ];
  const all: ListFilter = { type: null, from: null, state: "any", hideOverridden: false };

  it("shows every copy from every catalog, a name's copies side by side, or only the winners with Hide overridden", () => {
    expect(label(rowsFor(all, records))).toEqual(["x@A", "x@B", "lint@A", "off@B", "style@A"]);
    expect(label(rowsFor({ ...all, hideOverridden: true }, records))).toEqual(["x@A", "lint@A", "off@B", "style@A"]);
    expect(rowsFor(all, records).map((r) => r.overrides)).toEqual([["B"], [], [], [], []]);
  });

  it("shows one catalog's own copies, overridden ones included, and the switched-off winners as Disabled", () => {
    const fromB = rowsFor({ ...all, from: "B", hideOverridden: true }, records);
    expect(label(fromB)).toEqual(["x@B", "off@B"]);
    expect(fromB[0]!.status).toBe("not installed");
    expect(rowsFor({ ...all, from: "A" }, records)[0]!.overrides).toEqual([]);
    expect(label(rowsFor({ ...all, state: "disabled" }, records))).toEqual(["off@B"]);
  });

  it("combines the type, the catalog and the state", () => {
    expect(label(rowsFor({ ...all, type: "skill" }, records))).toEqual(["x@A", "x@B", "lint@A", "off@B"]);
    expect(label(rowsFor({ ...all, type: "prompt", state: "installed" }, records))).toEqual(["style@A"]);
    expect(label(rowsFor({ ...all, type: "skill", from: "B", state: "installed" }, records))).toEqual(["off@B"]);
    expect(label(rowsFor({ ...all, type: "agent" }, records))).toEqual([]);
  });
});

describe("UI-11: search", () => {
  const rows = rowsFor(
    { type: null, from: null, state: "any", hideOverridden: false },
    [
      entryRecord({ name: "notify", description: "Posts a Slack message" }),
      entryRecord({ name: "slack-thread", description: "Reads a thread" }),
      entryRecord({ name: "post-to-slack", description: "Posts" }),
      entryRecord({ name: "slack-thread", catalog: "team", overriddenBy: "personal", description: "Team copy" }),
      entryRecord({ name: "lint", description: "Lints" }),
    ],
  );

  it("ranks a name prefix, then a name match, then a description match, and drops the rest", () => {
    expect(searchRows(rows, "slack").map((r) => r.entry.name)).toEqual(["slack-thread", "slack-thread", "post-to-slack", "notify"]);
  });

  it("ignores case and surrounding space, and returns everything for an empty query", () => {
    expect(searchRows(rows, "  SLACK-T ").map((r) => r.entry.catalog)).toEqual(["personal", "team"]);
    expect(searchRows(rows, "   ")).toEqual(rows);
  });
});

describe("UI-27: how a push ended", () => {
  const base = { name: "tidy", catalog: "team", dest: "/Users/dev/.claude/skills/tidy", note: null, changed: true };

  it("calls an unchanged push nothing to push, and a local one a copy written straight through", () => {
    expect(describePush({ ...base, changed: false, kind: "local", target: "/src/tidy" })).toEqual({
      headline: "Nothing to push.",
      detail: "The local copy of tidy already matches its source.",
      link: null,
    });
    expect(describePush({ ...base, kind: "local", target: "/src/tidy" })).toEqual({
      headline: "Copied tidy back to its source.",
      detail: "/src/tidy — a local source is written straight through, with no pull request.",
      link: null,
    });
  });

  it("says opened only when the host's API opened the pull request; a pushed branch offers its compare link", () => {
    const api = { method: "api" as const, branch: "library/update-tidy-1", prUrl: "https://github.com/acme/skills/pull/7", compareUrl: "https://github.com/acme/skills/compare/main...library/update-tidy-1" };
    expect(describePush({ ...base, kind: "remote", pr: api })).toEqual({ headline: "Pull request opened.", detail: "From library/update-tidy-1.", link: { url: api.prUrl, label: "View the pull request" } });

    const manual = describePush({ ...base, kind: "remote", pr: { method: "manual", branch: "library/update-tidy-1", compareUrl: api.compareUrl } });
    expect(manual.headline).toBe("Branch pushed — the pull request is not open yet.");
    expect(manual.detail).toContain("nobody has been asked to review anything");
    expect(manual.link).toEqual({ url: api.compareUrl, label: "Open a pull request" });
    expect(describePush({ ...base, kind: "remote", pr: { method: "manual", branch: "b", compareUrl: null } }).link).toBeNull();
  });
});
