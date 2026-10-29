import type { EntryRecord } from "@loadout/core";
import { entryRecord } from "@loadout/core/testing";
import { flushPromises } from "@vue/test-utils";
import { defineStore } from "pinia";
import { describe, expect, it } from "vitest";
import { defineComponent, h, ref } from "vue";
import { useAuditLog, useLibrary } from "../services.ts";
import { mountView } from "./mountView.ts";

// Stands in for the screens' stores: a setup store that injects the library and the audit log.
const useProbeStore = defineStore("probe", () => {
  const library = useLibrary();
  const log = useAuditLog();
  const entries = ref<EntryRecord[]>([]);
  const commands = ref(log.events().length);
  log.subscribe(() => commands.value++);
  async function load() {
    const listed = await library.list();
    if (listed.ok) entries.value = listed.value;
  }
  return { entries, commands, load };
});

const Probe = defineComponent({
  props: { heading: { type: String, required: true } },
  setup(props) {
    const store = useProbeStore();
    void store.load();
    return () => h("section", [h("h2", props.heading), h("p", `${store.commands} commands`), h("ul", store.entries.map((e) => h("li", `${e.catalog}/${e.name}: ${e.state}`)))]);
  },
});

describe("mountView", () => {
  it("renders a component whose stores read the seeded fake and the audit log", async () => {
    const { wrapper, log } = mountView(Probe, {
      props: { heading: "Entries" },
      audit: [{ kind: "proc:start", id: 1, argv: ["git", "pull", "--ff-only"], cwd: "/app/clones/team" }],
    });
    await flushPromises();

    expect(wrapper.find("h2").text()).toBe("Entries");
    expect(wrapper.find("p").text()).toBe("1 commands");
    expect(wrapper.findAll("li").map((li) => li.text())).toContain("team/lint: drifted");

    log.record({ kind: "proc:end", id: 1, code: 0, durationMs: 40 });
    await flushPromises();
    expect(wrapper.find("p").text()).toBe("2 commands");
  });

  it("takes a seed and the fake ops a test models, with a fresh store per mount", async () => {
    const calls: string[] = [];
    const seed = { entries: [entryRecord({ name: "only" })] };
    const first = mountView(Probe, { props: { heading: "A" }, seed, library: { list: async () => (calls.push("list"), { ok: true, value: [], warnings: [] }) } });
    const second = mountView(Probe, { props: { heading: "B" }, seed });
    await flushPromises();

    expect(calls).toEqual(["list"]);
    expect(first.wrapper.findAll("li")).toEqual([]);
    expect(second.wrapper.findAll("li").map((li) => li.text())).toEqual(["personal/only: not_installed"]);
    expect(second.library.state.entries).toEqual(seed.entries);
  });
});
