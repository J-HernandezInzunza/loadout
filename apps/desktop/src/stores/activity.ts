import type { AuditEvent } from "@loadout/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useAuditLog } from "../services.ts";

/**
 * What the app is doing: the git commands the host has started and not yet finished (from the audit log),
 * and intents, which the UI declares in the click handler so the activity bar is up in the same frame
 * rather than once the first command lands.
 */
export const useActivityStore = defineStore("activity", () => {
  const log = useAuditLog();
  const running = ref(new Set<number>());
  const intents = ref(new Map<number, string>());
  let nextIntentId = 1;

  function track(event: AuditEvent) {
    if (event.kind === "proc:start") running.value.add(event.id);
    else if (event.kind === "proc:end") running.value.delete(event.id);
  }
  for (const event of log.events()) track(event);
  log.subscribe(track);

  /** Runs `work` under an intent labelled `label`, ended however the work ends. */
  async function withActivity<T>(label: string, work: () => Promise<T>): Promise<T> {
    const id = nextIntentId++;
    intents.value.set(id, label);
    try {
      return await work();
    } finally {
      intents.value.delete(id);
    }
  }

  const busy = computed(() => intents.value.size > 0 || running.value.size > 0);
  return { busy, withActivity };
});
