<script setup lang="ts">
import type { Library } from "@loadout/core";
import { onMounted, ref } from "vue";
import { useAppVersion } from "../appVersion.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";
import UiCheckbox from "./ui/UiCheckbox.vue";

type Report = Extract<Awaited<ReturnType<Library["doctor"]>>, { ok: true }>["value"];
type Finding = Report["errors"][number];

defineProps<{
  /** the title of the page Back returns to */
  back: string;
}>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const views = useViewStore();
const version = useAppVersion();

const report = ref<Report | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);
const deep = ref(false);
const recloning = ref("");

const subject = (finding: Finding) => finding.entry ?? finding.catalog;

async function run() {
  loading.value = true;
  failure.value = null;
  const checked = await activity.withActivity(deep.value ? "checking every source…" : "checking the catalogs…", () => library.doctor({ deep: deep.value }));
  loading.value = false;
  if (checked.ok) report.value = checked.value;
  else failure.value = checked.error.message;
}

/** A4: a clone that diverged from its origin is replaced by a fresh one, then checked again. */
async function reclone(id: string) {
  recloning.value = id;
  const done = await activity.withActivity(`re-cloning ${id}…`, () => library.recloneCatalog(id));
  recloning.value = "";
  if (!done.ok) {
    failure.value = done.error.message;
    return;
  }
  await Promise.all([run(), catalog.reload()]);
}

/** Over to the install page for that name, which asks before replacing anything. */
function replace(name: string) {
  views.doctor = false;
  views.manage = null;
  views.installFor = name;
}

onMounted(run);
</script>

<template>
  <section class="view">
    <PageHeader
      title="Catalog health"
      :back="back"
      @back="views.doctor = false"
    >
      <template #actions>
        <!-- Disabled while running, so a click mid-run can't start a second run. -->
        <label class="doctor__deep">
          <UiCheckbox
            v-model="deep"
            :disabled="loading"
            @change="run()"
          />
          Deep checks (reaches the network)
        </label>
        <button
          type="button"
          class="ghost"
          :disabled="loading"
          @click="run()"
        >
          {{ loading ? "Checking…" : "Re-run" }}
        </button>
      </template>

      <BusyIndicator
        v-if="loading"
        :label="deep ? 'Checking every source…' : 'Checking the catalogs…'"
      />
      <StatusBanner
        v-else-if="failure"
        kind="error"
        :detail="failure"
      />
      <template v-else-if="report">
        <!-- First, so a report copied into a bug says which build it came from. -->
        <p
          v-if="version"
          class="doctor__version"
        >
          Loadout {{ version }}
        </p>
        <p class="doctor__summary fade-in">
          {{ report.entries }} entries · {{ report.errors.length }} errors · {{ report.warnings.length }} warnings
        </p>
        <p
          v-if="!report.errors.length && !report.warnings.length"
          class="doctor__clean"
        >
          Nothing to report.
        </p>
        <template
          v-for="group in [
            { title: 'Errors', items: report.errors, error: true },
            { title: 'Warnings', items: report.warnings, error: false },
          ]"
          :key="group.title"
        >
          <template v-if="group.items.length">
            <h3
              class="doctor__section"
              :class="{ 'doctor__section--error': group.error }"
            >
              {{ group.title }}
            </h3>
            <ul class="doctor__list fade-in">
              <li
                v-for="(item, i) in group.items"
                :key="i"
                class="doctor__item"
                :class="{ 'doctor__item--error': group.error }"
              >
                <span
                  v-if="subject(item)"
                  class="doctor__subject"
                >{{ subject(item) }}</span>
                <span class="doctor__message">{{ item.message }}</span>
                <button
                  v-if="item.action?.kind === 'reclone'"
                  type="button"
                  class="ghost btn-xs"
                  :disabled="!!recloning"
                  @click="reclone(item.action.catalog)"
                >
                  {{ recloning === item.action.catalog ? "Re-cloning…" : `Re-clone ${item.action.catalog}` }}
                </button>
                <!-- The install page asks before anything is replaced. -->
                <button
                  v-else-if="item.action?.kind === 'replace'"
                  type="button"
                  class="ghost btn-xs"
                  @click="replace(item.action.name)"
                >
                  Replace with the catalog's copy
                </button>
              </li>
            </ul>
          </template>
        </template>
      </template>
    </PageHeader>
  </section>
</template>

<style scoped>
.doctor__deep {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  opacity: 0.75;
}
.doctor__version {
  margin: 0.75rem 0 0;
  font-size: 0.8rem;
  opacity: 0.6;
}
.doctor__version + .doctor__summary {
  margin-top: 0.25rem;
}
.doctor__summary {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  opacity: 0.7;
}
.doctor__clean,
.doctor__section {
  margin: 1.5rem 0 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
}
.doctor__section--error {
  color: var(--status-danger-ink);
  opacity: 0.85;
}
.doctor__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.doctor__item {
  padding: 0.55rem 0.85rem;
  border-radius: 8px;
  border-left: 3px solid var(--status-override-edge);
  background: var(--surface-raised);
  font-size: 0.83rem;
  line-height: 1.45;
}
.doctor__item--error {
  border-left-color: var(--status-danger-ink);
}
.doctor__subject {
  display: inline-block;
  margin-right: 0.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 4px;
  background: var(--surface-sunken);
  font-weight: 600;
  font-size: 0.75rem;
}
.doctor__message {
  overflow-wrap: anywhere;
  opacity: 0.85;
}
</style>
