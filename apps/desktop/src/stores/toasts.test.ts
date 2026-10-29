import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINGER, useToastStore } from "./toasts.ts";

// Driven off LINGER rather than literals: what is asserted is that a notice goes on its own and a failure
// outlasts a success.
describe("UI-52: toasts", () => {
  let store: ReturnType<typeof useToastStore>;
  const messages = () => store.toasts.map((toast) => toast.message);

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    store = useToastStore();
  });
  afterEach(() => vi.useRealTimers());

  it("takes a success back on its own after 4 s", () => {
    expect(LINGER.success).toBe(4_000);
    store.notify({ kind: "success", message: "grilling is switched off." });
    vi.advanceTimersByTime(LINGER.success - 1);
    expect(messages()).toEqual(["grilling is switched off."]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("keeps a failure up for 6 s, longer than a success", () => {
    expect(LINGER.error).toBe(6_000);
    store.notify({ kind: "error", message: "Could not switch grilling.", detail: "refused" });
    vi.advanceTimersByTime(LINGER.success);
    expect(messages()).toHaveLength(1);
    vi.advanceTimersByTime(LINGER.error - LINGER.success);
    expect(messages()).toEqual([]);
  });

  it("can be dismissed early, and its timer goes with it", () => {
    const id = store.notify({ kind: "error", message: "Could not switch grilling." });
    store.dismiss(id);
    expect(messages()).toEqual([]);

    store.notify({ kind: "success", message: "second" });
    vi.advanceTimersByTime(LINGER.success - 1);
    expect(messages()).toEqual(["second"]);
  });

  it("holds while the pointer is on it, and leaving restarts the full timer", () => {
    const id = store.notify({ kind: "error", message: "Could not switch grilling." });
    vi.advanceTimersByTime(LINGER.error - 1_000);
    store.hold(id);
    vi.advanceTimersByTime(60_000);
    expect(messages()).toHaveLength(1);

    store.release(id);
    vi.advanceTimersByTime(LINGER.error - 1);
    expect(messages()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("stacks oldest first, each on its own clock", () => {
    const gap = LINGER.success / 2;
    store.notify({ kind: "success", message: "first" });
    vi.advanceTimersByTime(gap);
    store.notify({ kind: "success", message: "second" });
    expect(messages()).toEqual(["first", "second"]);

    vi.advanceTimersByTime(LINGER.success - gap);
    expect(messages()).toEqual(["second"]);
    vi.advanceTimersByTime(gap);
    expect(messages()).toEqual([]);
  });
});
