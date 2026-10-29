import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PageHeader from "./PageHeader.vue";

describe("UI-55: PageHeader", () => {
  it("names the destination on its back button, and emits back when pressed", async () => {
    const header = mount(PageHeader, {
      props: { title: "tidy", back: "Catalogs" },
      slots: { default: "<p>page</p>", actions: "<button>Install</button>", badges: "<span>skill</span>" },
    });
    const back = header.find(".view__head button");
    expect(back.text()).toBe("← Catalogs");
    expect(header.find(".page-title__heading").text()).toBe("tidy");
    expect(header.find(".page-title__actions").text()).toBe("Install");
    expect(header.find(".view__body p").text()).toBe("page");

    await back.trigger("click");
    expect(header.emitted("back")).toHaveLength(1);
  });

  it("draws no head row without a back destination", () => {
    expect(mount(PageHeader, { props: { title: "Library" } }).find(".view__head").exists()).toBe(false);
  });
});
