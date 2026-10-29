import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../stores/toasts.ts";
import { mountView } from "../testing/mountView.ts";
import ToastStack from "./ToastStack.vue";

describe("UI-52: ToastStack", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows each notice with its role and detail, holds it under the pointer and dismisses it", async () => {
    const { wrapper } = mountView(ToastStack);
    const store = useToastStore();
    store.notify({ kind: "success", message: "grilling is switched off." });
    store.notify({ kind: "error", message: "Could not switch lint.", detail: "settings.json is not valid JSON" });
    await flushPromises();

    const items = wrapper.findAll(".toasts__item");
    expect(items.map((i) => [i.attributes("role"), i.find(".toasts__message").text()])).toEqual([
      ["status", "grilling is switched off."],
      ["alert", "Could not switch lint."],
    ]);
    expect(items[1]!.find("pre").text()).toBe("settings.json is not valid JSON");
    expect(items[0]!.find("pre").exists()).toBe(false);

    await items[1]!.trigger("mouseenter");
    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(store.toasts.map((t) => t.message)).toEqual(["Could not switch lint."]);

    await wrapper.find("[aria-label='Dismiss: Could not switch lint.']").trigger("click");
    expect(store.toasts).toEqual([]);
  });
});
