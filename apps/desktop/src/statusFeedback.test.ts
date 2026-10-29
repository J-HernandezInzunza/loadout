// One outcome surface per command, guarded against the source: a view rendering its own error box
// type-checks and looks fine alone; it is only wrong next to the success message it disagrees with.
import { describe, expect, it } from "vitest";
import { components } from "./assets/styleSources.ts";

const views = () => components().filter(([path]) => !path.endsWith("/StatusBanner.vue"));

describe("UI-51: status feedback", () => {
  it("is actually reading the components", () => {
    expect(views().map(([path]) => path)).toEqual(expect.arrayContaining(["components/ToastStack.vue", "components/PageHeader.vue"]));
  });

  it("renders every command outcome through the shared banner", () => {
    const offenders = views()
      .filter(([, src]) => /\bconst (error|failure) = ref/.test(src) && !src.includes("<StatusBanner"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("leaves no view defining its own error box", () => {
    // `--error` modifiers are fine: they style findings inside a report, not the command's outcome.
    const offenders = views()
      .filter(([, src]) => /^\.[a-z-]+__(error|failure)\s*\{/m.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("keeps the banner the only thing styling an outcome, with stderr's line breaks kept", () => {
    const banner = components().find(([path]) => path.endsWith("/StatusBanner.vue"))![1];
    expect(banner).toContain(".status-banner--success");
    expect(banner).toContain(".status-banner--error");
    expect(banner).toContain("white-space: pre-wrap");
  });
});
