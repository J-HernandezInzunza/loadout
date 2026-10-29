<script setup lang="ts">
import type { EntryRecord } from "@loadout/core";
import { ref } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import BusyIndicator from "./BusyIndicator.vue";

const props = defineProps<{
  entry: EntryRecord;
  dest: string;
  /** installed entries that depend on this one, left incomplete by the deletion */
  affected: string[];
}>();
const emit = defineEmits<{
  /** what the deletion did, for the banner above the copies */
  done: [outcome: { kind: "success" | "error"; text: string; detail?: string }];
  close: [];
}>();

const library = useLibrary();
const activity = useActivityStore();
const running = ref(false);
/** Loadout has no receipt for the copy, so deleting it is a second, separate decision */
const refused = ref(false);

/** Q17 A: an override for the name goes with the copy, so the confirmation names it. */
const override = props.entry.disabled ? "off" : props.entry.skillOverride;

async function remove(force: boolean) {
  running.value = true;
  const result = await activity.withActivity(`removing ${props.entry.name}…`, () =>
    library.uninstall({ names: [props.entry.name], ...(force && { forcePaths: [props.dest] }) }),
  );
  running.value = false;
  if (!result.ok) return emit("done", { kind: "error", text: `Could not remove ${props.entry.name}.`, detail: result.error.message });
  const item = result.value.items[0];
  if (item?.outcome === "refused") {
    refused.value = true;
    return;
  }
  const removed = item?.overrideRemoved ? ` Its ${item.overrideRemoved} setting in Claude Code's settings went with it.` : "";
  emit("done", { kind: "success", text: `Removed ${props.dest}. The catalog entry is still listed.${removed}` });
}
</script>

<template>
  <section class="uninstall">
    <!-- A refusal is a second confirmation, never a retry: force is only ever pressed from here. -->
    <div
      v-if="refused"
      class="uninstall__refused"
    >
      <p class="uninstall__question">
        Loadout has no install receipt for this path, so it cannot prove it created it:
      </p>
      <p class="uninstall__paths">
        <code>{{ dest }}</code>
      </p>
      <p class="uninstall__note">
        Deleting anyway removes whatever is there, including anything you put there yourself.
      </p>
      <div class="uninstall__actions">
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          Leave it alone
        </button>
        <button
          type="button"
          class="danger"
          :disabled="running"
          @click="remove(true)"
        >
          Delete anyway
        </button>
      </div>
    </div>

    <div
      v-else
      class="uninstall__confirm"
    >
      <p class="uninstall__question">
        Delete the installed copy of {{ entry.name }}?
      </p>
      <p class="uninstall__paths">
        <code>{{ dest }}</code>
      </p>
      <p
        v-if="affected.length"
        class="uninstall__affected"
      >
        {{ affected.length }} installed
        {{ affected.length === 1 ? "entry depends" : "entries depend" }} on this and will be left incomplete:
        {{ affected.join(", ") }}.
      </p>
      <p
        v-if="override"
        class="uninstall__override"
      >
        Its {{ override }} setting in Claude Code's settings is removed with it.
      </p>
      <p class="uninstall__note">
        The catalog entry is untouched. Installing it again brings the files back.
      </p>
      <div class="uninstall__actions">
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="danger"
          :disabled="running"
          @click="remove(false)"
        >
          Delete
        </button>
      </div>
    </div>

    <BusyIndicator
      v-if="running"
      inline
      label="Removing files…"
    />
  </section>
</template>

<style scoped>
.uninstall__question {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
}
.uninstall__paths {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}
.uninstall__affected,
.uninstall__override {
  margin: 0.5rem 0 0;
  font-size: 0.82rem;
  color: var(--status-attention-ink);
}
.uninstall__note {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  opacity: 0.7;
}
.uninstall__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
</style>
