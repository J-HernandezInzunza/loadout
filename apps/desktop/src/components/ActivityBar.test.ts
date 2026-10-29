import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useActivityStore } from "../stores/activity.ts";
import { mountView } from "../testing/mountView.ts";
import ActivityBar from "./ActivityBar.vue";

describe("UI-50: ActivityBar", () => {
  it("shows while a command the host started is running, including one already running at mount", async () => {
    const { wrapper, log } = mountView(ActivityBar, { audit: [{ kind: "proc:start", id: 1, argv: ["git", "pull"], cwd: "/c" }] });
    expect(wrapper.find(".activity").exists()).toBe(true);

    log.record({ kind: "proc:end", id: 1, code: 0, durationMs: 10 });
    await flushPromises();
    expect(wrapper.find(".activity").exists()).toBe(false);
  });

  it("shows from the moment an intent is declared until its work settles, failure included", async () => {
    const { wrapper } = mountView(ActivityBar);
    let fail: (e: Error) => void = () => {};
    const work = useActivityStore().withActivity("Installing tidy", () => new Promise<void>((_, reject) => (fail = reject)));
    await flushPromises();
    expect(wrapper.find(".activity").exists()).toBe(true);

    fail(new Error("no network"));
    await expect(work).rejects.toThrow("no network");
    await flushPromises();
    expect(wrapper.find(".activity").exists()).toBe(false);
  });
});
