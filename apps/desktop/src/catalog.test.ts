import { entryRecord, installedRecord } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import { catalogHue, installStatus, rowsFor, searchRows } from "./catalog.ts";

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

describe("UI-12: which rows a tab shows", () => {
  const records = [
    entryRecord({ name: "x", catalog: "A", overrides: ["B"] }),
    entryRecord({ name: "lint", catalog: "A" }),
    entryRecord({ name: "x", catalog: "B", overriddenBy: "A" }),
    installedRecord("installed", { name: "off", catalog: "B", disabled: true }),
  ];

  it("shows every copy on All, a name's copies side by side, or only the winners with Hide overridden", () => {
    expect(label(rowsFor({ kind: "all" }, records, false))).toEqual(["x@A", "x@B", "lint@A", "off@B"]);
    expect(label(rowsFor({ kind: "all" }, records, true))).toEqual(["x@A", "lint@A", "off@B"]);
    expect(rowsFor({ kind: "all" }, records, false).map((r) => r.overrides)).toEqual([["B"], [], [], []]);
  });

  it("shows a catalog's own copies on its tab, overridden ones included, and the switched-off winners on disabled", () => {
    const tabB = rowsFor({ kind: "catalog", id: "B" }, records, true);
    expect(label(tabB)).toEqual(["x@B", "off@B"]);
    expect(tabB[0]!.status).toBe("not installed");
    expect(label(rowsFor({ kind: "catalog", id: "A" }, records, false)).every((l) => l.endsWith("@A"))).toBe(true);
    expect(rowsFor({ kind: "catalog", id: "A" }, records, false)[0]!.overrides).toEqual([]);
    expect(label(rowsFor({ kind: "disabled" }, records, false))).toEqual(["off@B"]);
  });
});

describe("UI-11: search", () => {
  const rows = rowsFor(
    { kind: "all" },
    [
      entryRecord({ name: "notify", description: "Posts a Slack message" }),
      entryRecord({ name: "slack-thread", description: "Reads a thread" }),
      entryRecord({ name: "post-to-slack", description: "Posts" }),
      entryRecord({ name: "slack-thread", catalog: "team", overriddenBy: "personal", description: "Team copy" }),
      entryRecord({ name: "lint", description: "Lints" }),
    ],
    false,
  );

  it("ranks a name prefix, then a name match, then a description match, and drops the rest", () => {
    expect(searchRows(rows, "slack").map((r) => r.entry.name)).toEqual(["slack-thread", "slack-thread", "post-to-slack", "notify"]);
  });

  it("ignores case and surrounding space, and returns everything for an empty query", () => {
    expect(searchRows(rows, "  SLACK-T ").map((r) => r.entry.catalog)).toEqual(["personal", "team"]);
    expect(searchRows(rows, "   ")).toEqual(rows);
  });
});
