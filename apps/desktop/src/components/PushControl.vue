<script setup lang="ts">
import type { EntryRecord, Library } from "@loadout/core";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { describePush, type PushOutcome } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import BusyIndicator from "./BusyIndicator.vue";

type Plan = Parameters<Library["applyPush"]>[0];

const props = defineProps<{
  entry: EntryRecord;
  dest: string;
}>();
const emit = defineEmits<{
  done: [outcome: { kind: "success" | "error"; text: string; detail?: string; push?: PushOutcome }];
  close: [];
}>();

const library = useLibrary();
const activity = useActivityStore();
const plan = ref<Plan | null>(null);
const running = ref(false);
const message = ref("");

const remote = computed(() => plan.value?.kind === "remote");

// Mounted because the button was pressed, so the dry run is the first thing to run.
onMounted(async () => {
  running.value = true;
  const result = await activity.withActivity(`checking what pushing ${props.entry.name} would send…`, (signal) =>
    library.planPush({ name: props.entry.name, catalog: props.entry.catalog, signal }),
  );
  running.value = false;
  if (result.ok) plan.value = result.value;
  else emit("done", { kind: "error", text: `Could not check ${props.entry.name}'s edits.`, detail: result.error.message });
});

// A remote plan holds a temp clone; one never applied is discarded rather than left behind.
onUnmounted(() => {
  if (plan.value) void library.discardPush(plan.value);
});

async function confirm() {
  const issued = plan.value;
  if (!issued) return;
  running.value = true;
  const result = await activity.withActivity(`pushing ${props.entry.name}…`, (signal) => library.applyPush(issued, { message: message.value, signal }));
  running.value = false;
  plan.value = null;
  if (!result.ok) return emit("done", { kind: "error", text: `Could not push ${props.entry.name}.`, detail: result.error.message });
  const outcome = describePush(result.value);
  emit("done", { kind: "success", text: outcome.headline, push: outcome });
}
</script>

<template>
  <section class="push">
    <p class="push__note">
      <template v-if="remote">
        This opens a pull request against the entry's source repository. Nobody's installed copy changes until
        that is merged.
      </template>
      <template v-else-if="plan">
        The source is a file on this machine, so this overwrites it directly — no pull request, no review.
      </template>
    </p>

    <BusyIndicator
      v-if="running && !plan"
      inline
      label="Checking what would be sent…"
    />

    <div
      v-if="plan"
      class="push__confirm fade-in"
    >
      <!-- Before the push, because afterwards it is a post-mortem. -->
      <p
        v-if="plan.note"
        class="push__provenance"
      >
        {{ plan.note }}
      </p>
      <p
        v-if="!plan.changed"
        class="push__question"
      >
        Nothing to send — this copy already matches its source.
      </p>
      <template v-else>
        <pre
          v-if="plan.kind === 'remote'"
          class="push__diff"
        >{{ plan.diff }}</pre>
        <p
          v-else
          class="push__dest"
        >
          Would overwrite <code>{{ plan.target }}</code>
        </p>
        <label
          v-if="remote"
          class="push__field"
        >
          <span>Message — the commit, and the pull request's title</span>
          <input
            v-model="message"
            type="text"
            :placeholder="`library: updated ${entry.name}`"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
          >
        </label>
      </template>

      <div class="push__actions">
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          v-if="plan.changed"
          type="button"
          :disabled="running"
          @click="confirm()"
        >
          {{ remote ? "Push and open a pull request" : "Overwrite the source" }}
        </button>
      </div>
      <BusyIndicator
        v-if="running"
        inline
        label="Sending…"
      />
    </div>
  </section>
</template>

<style scoped>
.push__note {
  margin: 0 0 0.6rem;
  font-size: 0.78rem;
  line-height: 1.45;
  opacity: 0.7;
}
.push__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.6rem;
  font-size: 0.78rem;
  opacity: 0.85;
}
.push__field input {
  padding: 0.4rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font-size: 0.85rem;
}
.push__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.6rem;
}
.push__confirm {
  padding: 0.75rem;
  border-radius: 8px;
  background: var(--accent-tint);
  border-left: 3px solid var(--accent-bright);
}
.push__provenance {
  margin: 0 0 0.6rem;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.push__question {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.45;
}
.push__dest {
  margin: 0;
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}
.push__diff {
  margin: 0;
  padding: 0.6rem 0.7rem;
  border-radius: 6px;
  max-height: 18rem;
  overflow: auto;
  background: var(--surface-hover);
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.72rem;
  line-height: 1.5;
}
</style>
