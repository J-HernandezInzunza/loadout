import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { h } from "vue";
import { components } from "../../assets/styleSources.ts";
import UiCheckbox from "./UiCheckbox.vue";
import UiRadio from "./UiRadio.vue";
import UiSelect from "./UiSelect.vue";

describe("the app's form controls", () => {
  it("leave no native select, checkbox or radio outside components/ui", () => {
    const offenders = components()
      .filter(([path]) => !path.startsWith("components/ui/"))
      .filter(([, source]) => /<select\b|type="(checkbox|radio)"/.test(source.replace(/<style[^>]*>.*?<\/style>/gs, "")))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("UiCheckbox", () => {
  it("binds a boolean", async () => {
    const box = mount(UiCheckbox, { props: { modelValue: false } });
    const input = box.find("input");
    expect(input.attributes("type")).toBe("checkbox");
    expect((input.element as HTMLInputElement).checked).toBe(false);
    await input.setValue(true);
    expect(box.emitted("update:modelValue")).toEqual([[true]]);
  });

  it("adds and removes its value in a list, as the requires lists use it", async () => {
    const ticked = mount(UiCheckbox, { props: { modelValue: ["skill:lint"], value: "skill:lint" } });
    expect((ticked.find("input").element as HTMLInputElement).checked).toBe(true);
    await ticked.find("input").setValue(false);
    expect(ticked.emitted("update:modelValue")).toEqual([[[]]]);

    const other = mount(UiCheckbox, { props: { modelValue: ["skill:lint"], value: "prompt:style" } });
    await other.find("input").setValue(true);
    expect(other.emitted("update:modelValue")).toEqual([[["skill:lint", "prompt:style"]]]);
  });

  it("passes attributes to the input, not its wrapper, and can be disabled", () => {
    const box = mount(UiCheckbox, { props: { modelValue: false }, attrs: { disabled: true, "aria-label": "Deep check", id: "deep" } });
    const input = box.find("input");
    expect(input.attributes()).toMatchObject({ "aria-label": "Deep check", id: "deep" });
    expect(input.element.hasAttribute("disabled")).toBe(true);
    expect(box.find(".ui-checkbox").attributes("aria-label")).toBeUndefined();
  });
});

describe("UiRadio", () => {
  it("is checked when the model holds its value, and sets it when picked", async () => {
    const off = mount(UiRadio, { props: { modelValue: "existing", value: "remote" }, attrs: { name: "mode" } });
    const input = off.find("input");
    expect(input.attributes()).toMatchObject({ type: "radio", name: "mode" });
    expect((input.element as HTMLInputElement).checked).toBe(false);
    await input.setValue(true);
    expect(off.emitted("update:modelValue")).toEqual([["remote"]]);

    const on = mount(UiRadio, { props: { modelValue: "remote", value: "remote" } });
    expect((on.find("input").element as HTMLInputElement).checked).toBe(true);
  });

  it("can be disabled", () => {
    const radio = mount(UiRadio, { props: { modelValue: "a", value: "b" }, attrs: { disabled: true } });
    expect(radio.find("input").element.hasAttribute("disabled")).toBe(true);
  });
});

describe("UiSelect", () => {
  const options = () => [h("option", { value: "" }, "every catalog"), h("option", { value: "team" }, "team (9)")];

  it("shows the model's option and sets the one picked", async () => {
    const select = mount(UiSelect, { props: { modelValue: "" }, slots: { default: options } });
    const field = select.find("select");
    expect((field.element as HTMLSelectElement).value).toBe("");
    expect(field.findAll("option").map((o) => o.text())).toEqual(["every catalog", "team (9)"]);
    await field.setValue("team");
    expect(select.emitted("update:modelValue")).toEqual([["team"]]);
  });

  it("passes class and attributes to the select, and can be disabled", () => {
    const select = mount(UiSelect, { props: { modelValue: "" }, slots: { default: options }, attrs: { class: "install-preview__source", "aria-label": "From", disabled: true } });
    const field = select.find("select");
    expect(field.classes()).toContain("install-preview__source");
    expect(field.attributes("aria-label")).toBe("From");
    expect(field.element.hasAttribute("disabled")).toBe(true);
  });
});
