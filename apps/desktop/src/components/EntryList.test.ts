import { catalogRow, entryRecord, installedRecord } from "@loadout/core/testing";
import { describe, expect, it } from "vitest";
import { rowsFor, SESSION_TIMING } from "../catalog.ts";
import { mountView } from "../testing/mountView.ts";
import EntryList from "./EntryList.vue";

const catalogs = [catalogRow({ id: "personal" }), catalogRow({ id: "team", precedence: 2 })];

function mountList(records: Parameters<typeof rowsFor>[1], showOrigin = true) {
  return mountView(EntryList, { props: { rows: rowsFor({ kind: "all" }, records, false), catalogs, showOrigin } }).wrapper;
}

describe("UI-18: an entry card", () => {
  it("shows type, name, origin, pins, precedence, badge, description and requires", () => {
    const list = mountList([
      installedRecord("installed", { name: "tidy", catalog: "team", pinned: true, overrides: ["personal"], requires: ["skill:lint", "prompt: style"] }),
      entryRecord({ name: "tidy", catalog: "personal", overriddenBy: "team", description: "Personal tidy" }),
    ]);
    const [winner, loser] = list.findAll(".entry-list__item");
    expect(winner!.find(".entry-list__type").text()).toBe("skill");
    const head = (card: typeof winner) => card!.findAll(".entry-list__head > span").map((s) => s.text());
    expect(head(winner)).toEqual(["tidy", "team", "pinned", "overrides personal", "installed"]);
    expect(winner!.find(".entry-list__desc").text()).toBe("tidy does a thing");
    expect(winner!.find(".entry-list__requires").text()).toBe("requires: skill:lint, prompt: style");
    expect(head(loser)).toEqual(["tidy", "personal", "overridden by team", "not installed"]);
    expect(loser!.find(".entry-list__requires").exists()).toBe(false);
  });

  it("opens the copy that was clicked, with its catalog, through a button named for it", async () => {
    const list = mountList([entryRecord({ name: "tidy", catalog: "team" }), entryRecord({ name: "tidy", catalog: "personal", overriddenBy: "team" })]);
    const open = list.findAll(".entry-list__open");
    expect(open.map((b) => b.attributes("aria-label"))).toEqual(["Open tidy", "Open tidy"]);
    await open[1]!.trigger("click");
    expect(list.emitted("select")).toEqual([[{ name: "tidy", catalog: "personal" }]]);
  });

  it("leaves origin and pins off when only one catalog is registered", () => {
    const list = mountList([entryRecord({ name: "tidy", pinned: true })], false);
    expect(list.find(".entry-list__origin").exists()).toBe(false);
    expect(list.find(".entry-list__pinned").exists()).toBe(false);
  });

  it("dashes and dims a switched-off card, whose tooltip says when the change lands and nothing about parking", () => {
    const list = mountList([installedRecord("installed", { name: "off", disabled: true }), installedRecord("installed", { name: "on" })]);
    const [off, on] = list.findAll(".entry-list__card");
    expect(off!.classes()).toContain("entry-list__card--off");
    expect(off!.find(".entry-list__open").attributes("title")).toBe(`disabled\n${SESSION_TIMING}`);
    expect(on!.find(".entry-list__open").attributes("title")).toBeUndefined();
  });
});
