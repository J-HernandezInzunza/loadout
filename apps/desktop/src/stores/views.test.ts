import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useViewStore } from "./views.ts";

describe("UI-08: the view stack", () => {
  let views: ReturnType<typeof useViewStore>;
  beforeEach(() => {
    setActivePinia(createPinia());
    views = useViewStore();
  });

  it("shows exactly one view, the first open in priority order, and falls back as each closes", () => {
    expect(views.current).toEqual({ kind: "list" });
    views.trail.push({ name: "tidy", catalog: "team" });
    views.installFor = "tidy";
    views.manage = { catalog: "team", entry: null };
    views.addingTo = "personal";
    views.accounts = true;
    views.sync = true;
    views.doctor = true;

    const seen = [];
    for (const close of [() => (views.doctor = false), () => (views.sync = false), () => (views.accounts = false), () => (views.addingTo = null), () => (views.manage = null), () => (views.installFor = null), () => views.trail.pop()]) {
      seen.push(views.current.kind);
      close();
    }
    seen.push(views.current.kind);
    expect(seen).toEqual(["doctor", "sync", "accounts", "add", "catalogs", "install", "entry", "list"]);
  });

  it("keeps a back trail of entry pages, each with its catalog", () => {
    views.trail.push({ name: "tidy", catalog: "team" }, { name: "lint", catalog: "team" });
    expect(views.current).toEqual({ kind: "entry", stop: { name: "lint", catalog: "team" }, back: { name: "tidy", catalog: "team" } });
    views.trail.pop();
    expect(views.current).toEqual({ kind: "entry", stop: { name: "tidy", catalog: "team" }, back: null });
  });

  it("prunes pages about names that vanished, keeping a stop another catalog still answers", () => {
    views.trail.push({ name: "tidy", catalog: "team" }, { name: "gone", catalog: "team" }, { name: "lint", catalog: "personal" });
    views.installFor = "gone";
    views.prune(new Set(["tidy", "lint"]));
    expect(views.trail.map((s) => s.name)).toEqual(["tidy", "lint"]);
    expect(views.installFor).toBeNull();
  });
});
