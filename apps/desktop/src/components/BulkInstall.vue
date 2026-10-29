<script setup lang="ts">
import { discardsEdits, type Library } from "@loadout/core";
import { computed, onUnmounted, ref, watch } from "vue";
import { describeDestState } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import BusyIndicator from "./BusyIndicator.vue";
import StatusBanner from "./StatusBanner.vue";
import UiCheckbox from "./ui/UiCheckbox.vue";

type Plan = Parameters<Library["applyInstall"]>[0];
type UninstallItem = Extract<Awaited<ReturnType<Library["uninstall"]>>, { ok: true }>["value"]["items"][number];

const props = defineProps<{
  names: string[];
  catalogId: string;
}>();
const emit = defineEmits<{ done: [] }>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();

const plan = ref<Plan | null>(null);
const running = ref(false);
const failure = ref<string | null>(null);
const acknowledged = ref(false);
const confirming = ref(false);
/** what the last action did, kept here because the selection that produced it is cleared */
const installed = ref<{ requested: number; dependencies: number } | null>(null);
const uninstalled = ref<UninstallItem[] | null>(null);

const items = computed(() => plan.value?.items ?? []);
const extras = computed(() => items.value.filter((i) => i.requiredBy.length));
const drifted = computed(() => (plan.value ? discardsEdits(plan.value) : []));
const unmanaged = computed(() => items.value.filter((i) => i.status === "ready" && i.needsConsent));
const canInstall = computed(() => !!plan.value && !running.value && !unmanaged.value.length && (!drifted.value.length || acknowledged.value));
const removed = computed(() => uninstalled.value?.filter((i) => i.outcome === "deleted") ?? []);
const refused = computed(() => uninstalled.value?.filter((i) => i.outcome === "refused") ?? []);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const installedText = computed(() => {
  if (!installed.value) return "";
  const { requested, dependencies } = installed.value;
  const extra = dependencies ? `, with ${dependencies} ${plural(dependencies, "dependency", "dependencies")}` : "";
  return `Installed ${requested} ${plural(requested, "entry", "entries")} from ${props.catalogId}${extra}.`;
});

async function discard() {
  const issued = plan.value;
  plan.value = null;
  if (issued) await library.discardPlan(issued);
}

function clearOutcomes() {
  failure.value = null;
  installed.value = null;
  uninstalled.value = null;
}

/** One plan for the whole selection, so shared dependencies are fetched once and gated once. */
async function preview() {
  await discard();
  clearOutcomes();
  confirming.value = false;
  acknowledged.value = false;
  running.value = true;
  const planned = await activity.withActivity(`checking what installing ${props.names.length} entries would change…`, (signal) =>
    library.planInstall({ names: props.names, signal }),
  );
  running.value = false;
  if (planned.ok) plan.value = planned.value;
  else failure.value = planned.error.message;
}

async function install() {
  const issued = plan.value;
  if (!issued) return;
  running.value = true;
  const applied = await activity.withActivity(`installing ${props.names.length} entries…`, (signal) => library.applyInstall(issued, { signal }));
  running.value = false;
  plan.value = null;
  if (!applied.ok) {
    failure.value = applied.error.message;
    return;
  }
  const requested = applied.value.installed.filter((i) => props.names.includes(i.name)).length;
  installed.value = { requested, dependencies: applied.value.installed.length - requested };
  if (applied.value.stopped) failure.value = `Stopped at ${applied.value.stopped.name}: ${applied.value.stopped.reason}`;
  await catalog.reload();
  emit("done");
}

function startUninstall() {
  void discard();
  clearOutcomes();
  confirming.value = true;
}

/** Never forced: a copy Loadout has no receipt for is refused and reported, not deleted. */
async function uninstall() {
  running.value = true;
  const result = await activity.withActivity(`removing ${props.names.length} entries…`, () => library.uninstall({ names: props.names }));
  running.value = false;
  confirming.value = false;
  if (!result.ok) {
    failure.value = result.error.message;
    return;
  }
  uninstalled.value = result.value.items;
  await catalog.reload();
  emit("done");
}

// A plan or a pending confirmation was about the selection that was showing.
watch(
  () => props.names.join("\n"),
  () => {
    void discard();
    confirming.value = false;
  },
);

onUnmounted(() => void discard());
</script>

<template>
  <section class="bulk card">
    <StatusBanner
      v-if="failure"
      kind="error"
      :detail="failure"
    />
    <StatusBanner
      v-if="installed"
      kind="success"
    >
      <p class="bulk__done">
        {{ installedText }}
      </p>
    </StatusBanner>
    <StatusBanner
      v-else-if="uninstalled"
      :kind="refused.length ? 'warning' : 'success'"
    >
      <p class="bulk__done">
        <template v-if="removed.length">
          Removed {{ removed.length }} {{ plural(removed.length, "entry", "entries") }} from this machine.
        </template>
        <template v-else-if="!refused.length">
          None of the selected entries were installed — nothing to remove.
        </template>
        <template v-if="refused.length">
          {{ refused.length }} {{ plural(refused.length, "entry was", "entries were") }} left in place because Loadout
          has no record of installing {{ plural(refused.length, "it", "them") }}:
          {{ refused.map((r) => r.name).join(", ") }}. Open {{ plural(refused.length, "it", "each") }} to remove
          {{ plural(refused.length, "it", "them") }} individually.
        </template>
      </p>
    </StatusBanner>

    <div class="bulk__bar">
      <span class="bulk__count">
        <template v-if="names.length">{{ names.length }} selected from {{ catalogId }}</template>
        <template v-else>
          Act on several at once: install a selection as one plan with shared dependencies fetched once, or remove
          them together. Select the entries you want.
        </template>
      </span>
      <button
        v-if="names.length"
        type="button"
        class="danger btn-sm"
        :disabled="running"
        @click="startUninstall()"
      >
        Uninstall
      </button>
      <button
        v-if="names.length"
        type="button"
        class="btn-sm"
        :disabled="running"
        @click="preview()"
      >
        {{ plan ? "Re-check" : "Preview install" }}
      </button>
    </div>

    <div
      v-if="confirming"
      class="bulk__confirm fade-in"
    >
      <p class="bulk__confirm-q">
        Remove the global copies of {{ names.length }} selected {{ plural(names.length, "entry", "entries") }}?
      </p>
      <p class="bulk__confirm-note">
        Entries that are not installed are skipped, and a copy Loadout has no receipt for is refused rather than
        force-deleted. The catalog entries are untouched — installing again brings the files back.
      </p>
      <div class="bulk__confirm-actions">
        <button
          type="button"
          class="ghost"
          :disabled="running"
          @click="confirming = false"
        >
          Cancel
        </button>
        <button
          type="button"
          class="danger"
          :disabled="running"
          @click="uninstall()"
        >
          Remove {{ names.length }}
        </button>
      </div>
    </div>

    <BusyIndicator
      v-if="running"
      inline
      :label="plan ? 'Fetching and writing files…' : 'Working…'"
    />

    <div
      v-if="plan"
      class="bulk__plan fade-in"
    >
      <p class="bulk__scope">
        nothing has been written · {{ items.length }} {{ plural(items.length, "destination", "destinations") }}
        <template v-if="extras.length">
          ({{ extras.length }} pulled in as dependencies)
        </template>
      </p>
      <p
        v-if="drifted.length"
        class="bulk__warning"
      >
        {{ drifted.length }} of these have local edits Loadout did not make. Installing replaces them, and they cannot
        be recovered afterwards.
      </p>
      <p
        v-if="unmanaged.length"
        class="bulk__warning"
      >
        {{ unmanaged.map((i) => i.name).join(", ") }} {{ plural(unmanaged.length, "holds a copy", "hold copies") }}
        Loadout didn't install, so Loadout leaves {{ plural(unmanaged.length, "it", "them") }} alone. Remove
        {{ plural(unmanaged.length, "it", "them") }} yourself, or untick {{ plural(unmanaged.length, "it", "them") }},
        to install the rest.
      </p>
      <ul class="bulk__items">
        <li
          v-for="item in items"
          :key="item.dest"
          class="bulk__item"
          :class="{ 'bulk__item--drifted': item.state === 'drifted' }"
        >
          <span class="bulk__item-name">{{ item.name }}</span>
          <span
            v-if="item.requiredBy.length"
            class="bulk__role"
          >dependency</span>
          <span
            class="bulk__state"
            :class="{ 'bulk__state--drifted': item.state === 'drifted' }"
          >{{ describeDestState(item.state) }}</span>
        </li>
      </ul>
      <label
        v-if="drifted.length"
        class="bulk__ack"
      >
        <UiCheckbox
          v-model="acknowledged"
        />
        Overwrite {{ drifted.length }} locally edited {{ plural(drifted.length, "copy", "copies") }}, discarding those edits.
      </label>
      <button
        type="button"
        :disabled="!canInstall"
        @click="install()"
      >
        Install {{ items.length }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.bulk {
  margin-bottom: 1rem;
}
.bulk__bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.bulk__count {
  flex: 1;
  font-size: 0.82rem;
  opacity: 0.8;
}
.bulk__scope {
  margin: 0.75rem 0 0;
  font-size: 0.75rem;
  opacity: 0.65;
}
.bulk__warning {
  margin: 0.6rem 0 0;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.bulk__items {
  list-style: none;
  margin: 0.6rem 0 0;
  padding: 0;
  max-height: 16rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.bulk__item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-size: 0.8rem;
}
.bulk__item--drifted {
  background: var(--status-attention-tint);
}
.bulk__item-name {
  flex: 1;
  font-weight: 500;
}
.bulk__role {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.5;
}
.bulk__state {
  font-size: 0.72rem;
  opacity: 0.65;
}
.bulk__state--drifted {
  color: var(--status-attention-ink);
  opacity: 1;
}
.bulk__ack {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  margin: 0.7rem 0;
  font-size: 0.8rem;
  line-height: 1.45;
}
.bulk__plan > button:last-of-type {
  margin-top: 0.7rem;
}
.bulk__done {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.4;
}
.bulk__confirm {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border-radius: 8px;
  background: var(--status-danger-tint);
  border-left: 3px solid var(--status-danger-ink);
}
.bulk__confirm-q {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.45;
}
.bulk__confirm-note {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  opacity: 0.8;
}
.bulk__confirm-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
</style>
