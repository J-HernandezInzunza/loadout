import type { EntryDetail as Detail, Library } from "@loadout/core";
import { catalogRow, entryRecord, installedRecord, receipt, seededState } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { SESSION_TIMING } from "../catalog.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import { mountView } from "../testing/mountView.ts";
import EntryDetail from "./EntryDetail.vue";

const ok = <T>(value: T) => ({ ok: true as const, value, warnings: [] });
const related = (name: string, extra: Partial<Detail["requires"][number]> = {}) => ({
  type: "skill" as const,
  name,
  catalog: "team",
  description: `${name} does a thing`,
  direct: true,
  installed: false,
  state: "not_installed" as const,
  ...extra,
});

function detail(extra: Partial<Detail> = {}): Detail {
  const entry = installedRecord("installed", { name: "tidy", catalog: "team" });
  return {
    name: "tidy",
    entry,
    copies: [{ catalog: "team", wins: true, subject: true, pinned: false, overrides: [], overriddenBy: null }],
    requires: [],
    unresolvedRequires: [],
    dependents: [],
    installs: [entry.receipt!],
    source: { raw: entry.source, kind: "github", org: "acme", repo: "skills", branch: "main", filePath: "skills/tidy/SKILL.md", parentPath: "skills/tidy", filename: "SKILL.md", cloneUrls: [] },
    ...extra,
  };
}

/** The seeded machine plus a personal copy of tidy, so both copies a page lists exist in the list. */
const seed = () => {
  const state = seededState();
  return { ...state, entries: [entryRecord({ name: "tidy", overriddenBy: "team" }), ...state.entries] };
};

async function mountDetail(shown: Detail | ((name: string, catalog?: string) => ReturnType<Library["show"]>) = detail(), stop = { name: "tidy", catalog: "team" }) {
  const asked: [string, string | undefined][] = [];
  const show = typeof shown === "function" ? shown : async () => ok(shown);
  const mounted = mountView(EntryDetail, {
    seed: seed(),
    props: { stop, back: "Loadout" },
    library: { show: async (name, o) => (asked.push([name, o?.catalog]), show(name, o?.catalog)) },
  });
  await useCatalogStore().reload();
  await flushPromises();
  return { ...mounted, asked };
}

type Wrapper = Awaited<ReturnType<typeof mountDetail>>["wrapper"];
const texts = (w: Wrapper, selector: string) => w.findAll(selector).map((e) => e.text().replace(/\s+/g, " "));
/** each match's child labels joined with spaces, as a reader sees them */
const labels = (w: Wrapper, selector: string) => w.findAll(selector).map((e) => e.findAll(":scope > *").map((c) => c.text()).join(" "));

describe("UI-22: the entry page loads", () => {
  it("the copy it was opened on, titled before the read returns, with type, catalog and status badges", async () => {
    let finish = () => {};
    const { wrapper, asked } = await mountDetail(() => new Promise((resolve) => (finish = () => resolve(ok(detail())))));
    expect(asked).toEqual([["tidy", "team"]]);
    expect(wrapper.find(".page-title__heading").text()).toBe("tidy");
    expect(wrapper.find(".busy").text()).toBe("Reading tidy…");

    finish();
    await flushPromises();
    expect(texts(wrapper, ".page-title > span")).toEqual(["skill", "team", "installed"]);
  });

  it("again when the page moves to another catalog's copy of the same name", async () => {
    const { wrapper, asked } = await mountDetail();
    await wrapper.setProps({ stop: { name: "tidy", catalog: "personal" } });
    await flushPromises();
    expect(asked).toEqual([
      ["tidy", "team"],
      ["tidy", "personal"],
    ]);
  });

  it("shows why it couldn't, and Back walks the trail", async () => {
    const { wrapper } = await mountDetail(async () => ({ ok: false, error: { code: "NOT_FOUND", message: "no entry named 'tidy'", query: "tidy", candidates: [] }, warnings: [] }));
    const views = useViewStore();
    expect(wrapper.find(".status-banner--error pre").text()).toBe("no entry named 'tidy'");
    views.trail.push({ name: "tidy", catalog: "team" });
    await wrapper.find(".view__head button").trigger("click");
    expect(views.trail).toEqual([]);
  });
});

describe("UI-23: a switched-off entry", () => {
  it("says nothing loads it and when the change lands, with no parked path", async () => {
    const { wrapper } = await mountDetail(detail({ entry: installedRecord("installed", { name: "tidy", catalog: "team", disabled: true }) }));
    expect(wrapper.find(".entry-detail__timing").text()).toBe(`Switched off, so nothing loads it. ${SESSION_TIMING}`);
    expect(wrapper.text()).not.toContain("Parked at");
  });
});

describe("UI-24: the source card", () => {
  it("names a remote source's host, repo and branch, then the file", async () => {
    const { wrapper } = await mountDetail();
    expect(texts(wrapper, ".card p").slice(0, 2)).toEqual(["github · acme/skills (main)", "skills/tidy/SKILL.md"]);
  });

  it("shows a local source as its path, and an unparseable one verbatim", async () => {
    const local = await mountDetail(detail({ source: { raw: "~/skills/tidy/SKILL.md", kind: "local", path: "/Users/dev/skills/tidy/SKILL.md" } }));
    expect(local.wrapper.find(".entry-detail__origin").text()).toBe("~/skills/tidy/SKILL.md");
    expect(local.wrapper.find(".entry-detail__path").exists()).toBe(false);
    const odd = await mountDetail(detail({ source: { raw: "not a source", kind: "unknown", error: "unrecognized" } }));
    expect(odd.wrapper.find(".entry-detail__origin").text()).toBe("not a source");
  });
});

describe("UI-25: On this machine", () => {
  it("lists the copy at the destination; silent about its catalog when it is the page's own", async () => {
    const { wrapper } = await mountDetail();
    expect(wrapper.find(".copies__heading").text()).toBe("On this machine (1)");
    expect(wrapper.find(".copies__dest").text()).toBe("/Users/dev/.claude/skills/tidy");
    expect(wrapper.find(".copies__foreign").exists()).toBe(false);
  });

  it("says when the copy there came from another catalog, or wasn't installed by Loadout", async () => {
    const entry = installedRecord("installed", { name: "tidy", catalog: "team" });
    const foreign = await mountDetail(detail({ entry: { ...entry, receipt: receipt({ ...entry, catalog: "personal" }) } }));
    expect(foreign.wrapper.find(".copies__foreign").text()).toBe("from personal, not team");

    const byHand = await mountDetail(detail({ entry: installedRecord("unmanaged", { name: "tidy", catalog: "team" }) }));
    expect(byHand.wrapper.find(".copies__unmanaged").text()).toBe("Loadout didn't install this copy, so it has no record of what it holds");
  });

  it("says so when nothing is installed", async () => {
    const { wrapper } = await mountDetail(detail({ entry: entryRecord({ name: "tidy", catalog: "team" }), installs: [] }));
    expect(wrapper.find(".copies__heading").text()).toBe("On this machine (0)");
    expect(wrapper.find(".copies__none").text()).toContain("Not installed anywhere yet.");
  });
});

describe("UI-29: copies and pins", () => {
  const copies = (pinned: boolean): Detail["copies"] => [
    { catalog: "personal", wins: !pinned, subject: false, pinned: false, overrides: pinned ? [] : ["team"], overriddenBy: pinned ? "team" : null },
    { catalog: "team", wins: pinned, subject: true, pinned, overrides: pinned ? ["personal"] : [], overriddenBy: pinned ? null : "personal" },
  ];

  it("says which copy installs and why, with each copy's source, and an edit link only where Loadout writes", async () => {
    const { wrapper } = await mountDetail(detail({ copies: copies(false) }));
    expect(wrapper.findAll(".entry-detail__section").map((h) => h.text())).toContain("Where this comes from (2 catalogs)");
    expect(wrapper.find(".entry-detail__copies-lead").text()).toContain("Decided by catalog order.");
    expect(labels(wrapper, ".entry-detail__copy-head")).toEqual(["personal first by catalog order — this is what installs Pin to this", "team overridden by personal Use this one"]);
    expect(texts(wrapper, ".entry-detail__copy-source")).toEqual([
      "https://github.com/acme/skills/blob/main/skills/tidy/SKILL.md",
      "https://github.com/acme/skills/blob/main/skills/tidy/SKILL.md",
    ]);

    const edit = wrapper.findAll(".entry-detail__edit");
    expect(edit.map((b) => b.text())).toEqual(["Edit this entry in personal", "Edit this entry in team"]);
    await edit[0]!.trigger("click");
    expect(useViewStore().current).toEqual({ kind: "catalogs", catalog: "personal", entry: "tidy" });
  });

  it("names the pin when there is one, and calls a single holder the catalog holding the name", async () => {
    const pinned = await mountDetail(detail({ copies: copies(true) }));
    expect(pinned.wrapper.find(".entry-detail__copies-lead").text()).toContain("Pinned to team, so its copy installs whatever the catalog order says.");
    expect(labels(pinned.wrapper, ".entry-detail__copy-head")[1]).toBe("team pinned — this is what installs Clear pin");

    const single = await mountDetail();
    expect(single.wrapper.findAll(".entry-detail__section").map((h) => h.text())).toContain("Catalog holding this name");
    expect(single.wrapper.find(".entry-detail__copies-lead").exists()).toBe(false);
  });
});

describe("UI-31: dependencies", () => {
  it("splits declared from inherited, lists dependents and what doesn't resolve, with one installed test for every pill", async () => {
    const { wrapper } = await mountDetail(
      detail({
        requires: [related("base", { direct: false, installed: true, state: "unmanaged" }), related("lint", { installed: true, state: "drifted" })],
        dependents: [related("deploy", { installed: true, state: "installed" }), related("ship", { direct: false })],
        unresolvedRequires: [
          { ref: "skill:gone", requiredBy: "tidy", reason: "not_found" },
          { ref: "lint", requiredBy: "tidy", reason: "malformed" },
          { ref: "skill:tidy", requiredBy: "lint", reason: "cycle" },
        ],
      }),
    );
    const sections = wrapper.findAll(".entry-detail__section").map((h) => h.text());
    expect(sections).toEqual(expect.arrayContaining(["Requires (1)", "Also installed, via those (1)", "Required by (2)", "Unresolved (3)"]));
    expect(labels(wrapper, ".entry-detail__dep-head")).toEqual(["lint installed", "base installed", "deploy installed", "ship via another entry not installed"]);
    expect(texts(wrapper, ".entry-detail__broken-why")).toEqual(["no catalog defines it", "not a valid type:name reference", "circular dependency"]);
    expect(wrapper.find(".entry-detail__broken .entry-detail__req-desc").text()).toBe("Required by tidy. This entry will install without it.");

    await wrapper.findAll(".entry-detail__dep")[0]!.trigger("click");
    expect(useViewStore().trail).toEqual([{ name: "lint", catalog: "team" }]);
  });
});

describe("App: an entry opened from the list", () => {
  it("is the page on screen, with Back named after the previous stop", async () => {
    const { wrapper } = mountView((await import("../App.vue")).default, { seed: { ...seededState(), catalogs: [catalogRow({ id: "team" })] } });
    await flushPromises();
    useViewStore().trail.push({ name: "tidy", catalog: "team" }, { name: "lint", catalog: "team" });
    await flushPromises();
    expect(wrapper.find(".page-title__heading").text()).toBe("lint");
    expect(wrapper.find(".view__head button").text()).toBe("← tidy");
  });
});
