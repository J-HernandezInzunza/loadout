<script setup lang="ts">
import type { EntryRecord } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import BusyIndicator from "./BusyIndicator.vue";
import StatusBanner from "./StatusBanner.vue";

const props = defineProps<{ entry: EntryRecord }>();
const emit = defineEmits<{
  close: [];
  /** what was removed, for the catalog page to say once this row is gone */
  removed: [text: string];
}>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const { entries } = storeToRefs(catalog);

const preview = ref<{ diff: string; dependents: string[] } | null>(null);
const running = ref(false);
const failure = ref<string | null>(null);
const purge = ref(false);

const request = computed(() => ({ name: props.entry.name, catalog: props.entry.catalog, type: props.entry.type }));
/**
 * What sits at the name's destination is the winning copy's, so only removing that copy may also delete
 * it; removing a losing copy leaves the installed one, which still has its catalog entry.
 */
const winner = computed(() => entries.value.find((e) => e.name === props.entry.name && e.type === props.entry.type && e.overriddenBy === null));
const installedHere = computed(() => props.entry.overriddenBy === null && props.entry.installed);

// A dry run first: the catalog diff and what still requires the entry, before anything changes.
onMounted(async () => {
  running.value = true;
  const result = await activity.withActivity(`checking what removing ${props.entry.name} would change…`, async (signal) => {
    const planned = await library.planRemove({ ...request.value, dryRun: true, signal });
    if (!planned.ok) return planned;
    const dependents = planned.value.op === "remove" ? planned.value.dependents : [];
    const applied = await library.applyCatalogEdit(planned.value, { signal });
    return applied.ok ? { ...applied, value: { diff: applied.value.diff ?? "", dependents } } : applied;
  });
  running.value = false;
  if (result.ok) preview.value = result.value;
  else failure.value = result.error.message;
});

async function confirm() {
  running.value = true;
  failure.value = null;
  const result = await activity.withActivity(`removing ${props.entry.name} from ${props.entry.catalog}…`, async (signal) => {
    const planned = await library.planRemove({ ...request.value, purge: purge.value, signal });
    return planned.ok ? library.applyCatalogEdit(planned.value, { signal }) : planned;
  });
  running.value = false;
  if (!result.ok) {
    failure.value = result.error.message;
    return;
  }
  const deleted = result.value.op === "remove" && result.value.deleted.length ? ` Deleted ${result.value.deleted.join(", ")}.` : "";
  emit("removed", `Removed ${props.entry.name} from ${props.entry.catalog}, out of ${props.entry.type}s.${deleted}`);
  await catalog.reload();
}
</script>

<template>
  <section class="remove">
    <StatusBanner
      v-if="failure"
      kind="error"
      :detail="failure"
    />
    <BusyIndicator
      v-if="running && !preview"
      inline
      label="Checking what would change…"
    />

    <div
      v-if="preview"
      class="remove__confirm fade-in"
    >
      <p class="remove__question">
        Remove {{ entry.name }} from {{ entry.catalog }}?
      </p>
      <p
        v-if="preview.dependents.length"
        class="remove__dependents"
      >
        {{ preview.dependents.length }} {{ preview.dependents.length === 1 ? "entry in" : "entries in" }} {{ entry.catalog }}
        still {{ preview.dependents.length === 1 ? "requires" : "require" }} this one and will no longer resolve:
        {{ preview.dependents.join(", ") }}.
      </p>
      <pre class="remove__diff">{{ preview.diff }}</pre>

      <template v-if="installedHere">
        <p class="remove__orphan">
          {{ entry.name }} is installed at {{ entry.locations[0] }}. Removing the catalog entry leaves those files where
          they are, and there will be no entry left to uninstall them from.
        </p>
        <label class="remove__purge">
          <input
            v-model="purge"
            type="checkbox"
          >
          <span>
            Also delete the installed copy. This deletes whatever is at {{ entry.locations[0] }}, including anything you
            put there yourself — the receipt check that normally refuses that does not apply here.
          </span>
        </label>
      </template>
      <p
        v-else-if="winner?.installed && winner.catalog !== entry.catalog"
        class="remove__orphan"
      >
        The copy installed under this name came from {{ winner.catalog }}, so removing {{ entry.catalog }}'s entry leaves
        it in place.
      </p>

      <p class="remove__note">
        Only {{ entry.catalog }}'s copy of the entry is removed. The file the source points at is not touched.
      </p>
      <div class="remove__actions">
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="running"
          @click="confirm()"
        >
          {{ purge ? "Remove and delete the copy" : "Remove the entry" }}
        </button>
      </div>
      <BusyIndicator
        v-if="running"
        inline
        label="Writing the catalog…"
      />
    </div>
  </section>
</template>

<style scoped>
.remove {
  margin-top: 0.75rem;
}
.remove__confirm {
  margin-top: 0.75rem;
  padding: 0.85rem;
  border-radius: 8px;
  background: var(--status-danger-tint);
  border-left: 3px solid var(--status-danger-ink);
}
.remove__question {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.45;
  font-weight: 600;
}
.remove__dependents {
  margin: 0.5rem 0 0;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.remove__diff {
  margin: 0.6rem 0 0;
  padding: 0.6rem 0.7rem;
  border-radius: 6px;
  max-height: 16rem;
  overflow: auto;
  background: var(--surface-hover);
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.72rem;
  line-height: 1.5;
  white-space: pre;
}
.remove__orphan {
  margin: 0.6rem 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  opacity: 0.85;
}
.remove__purge {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  margin-top: 0.5rem;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  background: var(--status-danger-tint);
  font-size: 0.78rem;
  line-height: 1.45;
}
.remove__note {
  margin: 0.6rem 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  opacity: 0.75;
}
.remove__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.remove__done {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.4;
}
.remove__done-detail {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  opacity: 0.8;
  overflow-wrap: anywhere;
}
</style>
