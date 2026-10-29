import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BusyIndicator from "./BusyIndicator.vue";

describe("UI-54: BusyIndicator", () => {
  it("is a polite status with a spinner and a contextual label, Working… by default", () => {
    const busy = mount(BusyIndicator);
    expect(busy.attributes("role")).toBe("status");
    expect(busy.find(".busy__spinner").exists()).toBe(true);
    expect(busy.text()).toBe("Working…");
    expect(mount(BusyIndicator, { props: { label: "Loading catalog…", inline: true } }).classes()).toContain("busy--inline");
  });
});
