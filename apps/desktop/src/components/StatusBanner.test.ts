import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StatusBanner from "./StatusBanner.vue";

describe("UI-51: StatusBanner", () => {
  it("announces a failure assertively and a success or warning politely", () => {
    const role = (kind: "success" | "error" | "warning") => mount(StatusBanner, { props: { kind }, slots: { default: "x" } }).attributes("role");
    expect([role("error"), role("success"), role("warning")]).toEqual(["alert", "status", "status"]);
  });

  it("shows the message with the detail verbatim in a pre, and offers no way to dismiss it", () => {
    const detail = "git exited 128.\nfatal: could not read from remote\n  ssh: Permission denied (publickey)";
    const banner = mount(StatusBanner, { props: { kind: "error", detail }, slots: { default: "Could not add the entry." } });

    expect(banner.text()).toContain("Could not add the entry.");
    expect(banner.find("pre").text()).toBe(detail);
    expect(banner.find("button").exists()).toBe(false);
  });

  it("renders no pre without a detail, so no empty gap shows under a success", () => {
    expect(mount(StatusBanner, { props: { kind: "success" }, slots: { default: "Done" } }).find("pre").exists()).toBe(false);
  });
});
