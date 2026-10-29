import type { AuditEvent, PlanItem } from "@loadout/core";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { useActivityStore } from "../stores/activity.ts";
import { mountView } from "../testing/mountView.ts";
import CommandLog from "./CommandLog.vue";

const start = (id: number, argv: string[]): AuditEvent => ({ kind: "proc:start", id, argv, cwd: "/app" });
const end = (id: number, code: number, durationMs: number): AuditEvent => ({ kind: "proc:end", id, code, durationMs });

async function mountLog(audit: AuditEvent[] = []) {
  const mounted = mountView(CommandLog, { audit });
  await mounted.wrapper.find(".command-log__toggle").trigger("click");
  return mounted;
}

describe("UI-49: CommandLog", () => {
  it("says nothing has run rather than showing an empty list, and the toggle reports it is expanded", async () => {
    const { wrapper } = mountView(CommandLog);
    const toggle = wrapper.find(".command-log__toggle");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".command-log__empty").text()).toBe("Nothing has run yet.");
    expect(wrapper.find(".command-log__count").text()).toBe("0");
  });

  it("shows a running command verbatim with no exit code, then its code and duration, newest first", async () => {
    const { wrapper, log } = await mountLog([start(1, ["git", "-C", "/app/clones/team", "pull", "--ff-only"])]);
    expect(wrapper.find(".command-log__argv").text()).toBe("git -C /app/clones/team pull --ff-only");
    expect(wrapper.find(".command-log__status").text()).toBe("…");

    log.record(start(2, ["git", "ls-remote", "https://x/o/r.git", "refs/heads/main"]));
    log.record(end(2, 0, 214));
    log.record(end(1, 128, 30));
    await flushPromises();

    const rows = wrapper.findAll(".command-log__row");
    expect(rows.map((r) => [r.find(".command-log__status").text(), r.find(".command-log__time").text()])).toEqual([
      ["0", "214ms"],
      ["128", "30ms"],
    ]);
    expect(rows[0]!.find(".command-log__status--failed").exists()).toBe(false);
    expect(rows[1]!.find(".command-log__status--failed").exists()).toBe(true);
    expect(wrapper.find(".command-log__count").text()).toBe("2");
  });

  it("ignores a finish for a command it never saw start", async () => {
    const { wrapper, log } = await mountLog();
    log.record(end(9999, 0, 5));
    await flushPromises();
    expect(wrapper.find(".command-log__count").text()).toBe("0");
  });

  it("shows the argv the host recorded and nothing else, so a token passed in git's env never appears", async () => {
    const argv = ["git", "-c", "credential.helper=", "clone", "https://bitbucket.org/acme/catalog.git"];
    const { wrapper } = await mountLog([start(3, argv)]);
    expect(wrapper.find(".command-log__list").text()).not.toContain("LOADOUT_GIT_TOKEN=");
    expect(wrapper.find(".command-log__argv").text()).toBe(argv.join(" "));
  });

  it("folds a command too long to read, and still holds all of it", async () => {
    const message = "Update tidy: ".repeat(30);
    const { wrapper } = await mountLog([start(4, ["git", "commit", "-m", message, "--quiet"])]);
    expect(wrapper.find(".command-log__argv").text().length).toBeLessThan(200);
    expect(wrapper.find(".command-log__more").text()).toBe("full");

    await wrapper.find(".command-log__more").trigger("click");
    expect(wrapper.find(".command-log__argv").text()).toContain("--quiet");
    expect(wrapper.find(".command-log__more").text()).toBe("less");
  });

  it("leaves a command that already fits alone", async () => {
    const { wrapper } = await mountLog([start(5, ["git", "--version"])]);
    expect(wrapper.find(".command-log__more").exists()).toBe(false);
  });

  it("names the running command beside the toggle, not inside it, and the intent before any command starts", async () => {
    const { wrapper, log } = await mountLog();
    let finish = () => {};
    void useActivityStore().withActivity("installing tidy…", () => new Promise<void>((resolve) => (finish = resolve)));
    await flushPromises();
    const activity = wrapper.find(".command-log__activity");
    expect(activity.text()).toBe("installing tidy…");
    expect(wrapper.find(".command-log__toggle .command-log__activity").exists()).toBe(false);

    log.record(start(6, ["git", "-C", "/tmp/op", "clone", "https://x/o/r.git"]));
    await flushPromises();
    expect(activity.text()).toBe("git clone");

    log.record(end(6, 0, 900));
    finish();
    await flushPromises();
    expect(activity.text()).toBe("");
  });

  it("cancels an install from the bar: the signal reaches the op, which stops and says so", async () => {
    const item = { type: "skill", name: "tidy", catalog: "team", status: "ready" } as PlanItem;
    const { wrapper, library } = mountView(CommandLog, {
      library: {
        applyInstall: (_plan, o) =>
          new Promise((resolve) =>
            o?.signal?.addEventListener("abort", () => resolve({ ok: true, value: { installed: [], stopped: null, aborted: true }, warnings: [] })),
          ),
      },
    });
    expect(wrapper.find(".command-log__right button").exists()).toBe(false);

    const installing = useActivityStore().withActivity("installing tidy…", (signal) => library.applyInstall({ items: [item] } as never, { signal }));
    await flushPromises();
    const cancel = wrapper.find(".command-log__right button");
    expect(cancel.text()).toBe("Cancel");
    await cancel.trigger("click");

    expect(await installing).toMatchObject({ ok: true, value: { aborted: true } });
    await flushPromises();
    expect(wrapper.find(".command-log__right button").exists()).toBe(false);
  });
});
