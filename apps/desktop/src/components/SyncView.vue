<script setup lang="ts">
import { discardsEdits, type Library } from "@loadout/core";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { describeDestState, summarizeChanges } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";

type Plan = Parameters<Library["applySync"]>[0];
type Report = Extract<Awaited<ReturnType<Library["applySync"]>>, { ok: true }>["value"];

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const views = useViewStore();

const plan = ref<Plan | null>(null);
const report = ref<Report | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);
const acknowledged = ref(false);

const toUpdate = computed(() => plan.value?.items ?? []);
const drifted = computed(() => (plan.value ? discardsEdits(plan.value) : []));
const canApply = computed(() => toUpdate.value.some((i) => i.status === "ready") && (!drifted.value.length || acknowledged.value));
/** "updated" means files were touched, not merely that the item ran */
const updated = computed(() => report.value?.synced.filter((i) => summarizeChanges(i.preview) !== "no changes") ?? []);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

async function discard() {
  const issued = plan.value;
  plan.value = null;
  if (issued) await library.discardPlan(issued);
}

/** Checks every installed entry against its source; nothing is written until Sync is pressed. */
async function check(force = false) {
  await discard();
  report.value = null;
  failure.value = null;
  acknowledged.value = false;
  loading.value = true;
  const planned = await activity.withActivity("checking every installed entry against its source…", (signal) => library.planSync({ force, signal }));
  loading.value = false;
  if (planned.ok) plan.value = planned.value;
  else failure.value = planned.error.message;
}

async function apply() {
  const issued = plan.value;
  if (!issued) return;
  loading.value = true;
  const applied = await activity.withActivity("syncing installed entries…", (signal) => library.applySync(issued, { signal }));
  loading.value = false;
  plan.value = null;
  if (!applied.ok) {
    failure.value = applied.error.message;
    return;
  }
  report.value = applied.value;
  await catalog.reload();
}

onMounted(() => check());
onUnmounted(() => void discard());
</script>

<template>
  <section class="view">
    <PageHeader
      title="Sync"
      back="Loadout"
      @back="views.sync = false"
    >
      <template #actions>
        <button
          type="button"
          class="ghost"
          :disabled="loading"
          @click="check()"
        >
          {{ loading ? "Checking…" : "Check again" }}
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="loading"
          @click="check(true)"
        >
          Force re-fetch
        </button>
      </template>

      <BusyIndicator
        v-if="loading"
        label="Checking every installed entry against its source…"
      />
      <StatusBanner
        v-else-if="failure"
        kind="error"
        :detail="failure"
      />

      <template v-else-if="plan">
        <p class="sync__summary fade-in">
          <strong
            v-if="toUpdate.length"
            class="sync__count"
          >{{ toUpdate.length }} to update</strong>
          <strong
            v-else
            class="sync__count sync__count--quiet"
          >Everything is up to date</strong>
          <span> · {{ plan.upToDate.length }} already up to date</span>
          <span> · nothing has been written</span>
        </p>
        <p
          v-if="drifted.length"
          class="sync__warning"
        >
          {{ drifted.map((i) => i.name).join(", ") }} {{ plural(drifted.length, "has", "have") }} local edits; syncing
          replaces them with the catalog's copy.
        </p>
        <ul
          v-if="toUpdate.length"
          class="sync__list fade-in"
        >
          <li
            v-for="item in toUpdate"
            :key="item.dest"
            class="sync__item sync__item--changed"
            :class="{ 'sync__item--drifted': item.state === 'drifted' }"
          >
            <div class="sync__head">
              <span class="sync__name">{{ item.name }}</span>
              <span
                v-if="item.requiredBy.length"
                class="sync__badge"
              >dependency</span>
              <span class="sync__badge">{{ describeDestState(item.state) }}</span>
              <span
                v-if="item.status !== 'ready'"
                class="sync__detail"
              >can't sync: {{ item.reason }}</span>
            </div>
          </li>
        </ul>
        <template v-if="plan.unmanaged.length">
          <h3 class="sync__section">
            Left alone · {{ plan.unmanaged.length }}
          </h3>
          <p class="sync__note">
            Loadout didn't install the copies at these destinations, so sync never overwrites them.
          </p>
          <ul class="sync__list">
            <li
              v-for="item in plan.unmanaged"
              :key="item.dest"
              class="sync__item sync__item--quiet"
            >
              <span class="sync__name">{{ item.name }}</span>
              <span class="sync__detail">{{ item.dest }}</span>
            </li>
          </ul>
        </template>
        <label
          v-if="drifted.length"
          class="sync__ack"
        >
          <input
            v-model="acknowledged"
            type="checkbox"
          >
          Overwrite {{ drifted.length }} locally edited {{ plural(drifted.length, "copy", "copies") }}, discarding those edits.
        </label>
        <button
          v-if="toUpdate.length"
          type="button"
          :disabled="!canApply"
          @click="apply()"
        >
          Sync {{ toUpdate.length }}
        </button>
      </template>

      <template v-else-if="report">
        <p class="sync__summary fade-in">
          <strong
            v-if="updated.length"
            class="sync__count"
          >{{ updated.length }} updated</strong>
          <strong
            v-else
            class="sync__count sync__count--quiet"
          >Nothing changed</strong>
          <span> · {{ report.upToDate.length }} already up to date</span>
          <span
            v-if="report.failed.length"
            class="sync__count--failed"
          > · {{ report.failed.length }} failed</span>
          <span
            v-if="report.missing.length"
            class="sync__count--gone"
          > · {{ report.missing.length }} gone from disk</span>
        </p>
        <template v-if="report.failed.length">
          <h3 class="sync__section sync__section--error">
            Failed
          </h3>
          <ul class="sync__list fade-in">
            <li
              v-for="item in report.failed"
              :key="item.name"
              class="sync__item sync__item--error"
            >
              <span class="sync__name">{{ item.name }}</span>
              <span class="sync__detail">{{ item.reason }}</span>
            </li>
          </ul>
        </template>
        <template v-if="report.missing.length">
          <h3 class="sync__section sync__section--gone">
            Gone from disk · {{ report.missing.length }}
          </h3>
          <p class="sync__note">
            The record was kept and nothing was deleted. Install one of these again to put a copy back, or uninstall it
            to drop the record.
          </p>
          <ul class="sync__list fade-in">
            <li
              v-for="item in report.missing"
              :key="item.dest"
              class="sync__item sync__item--gone"
            >
              <span class="sync__name">{{ item.name }}</span>
              <p class="sync__path">
                {{ item.dest }}
              </p>
            </li>
          </ul>
        </template>
        <template v-if="report.synced.length">
          <h3 class="sync__section sync__section--changed">
            Synced · {{ report.synced.length }}
          </h3>
          <ul class="sync__list fade-in">
            <li
              v-for="item in report.synced"
              :key="item.dest"
              class="sync__item sync__item--changed"
            >
              <div class="sync__head">
                <span class="sync__name">{{ item.name }}</span>
                <span class="sync__badge">{{ summarizeChanges(item.preview) }}</span>
              </div>
              <ul
                v-if="item.preview.kind === 'files' && !item.preview.newInstall"
                class="sync__files"
              >
                <li
                  v-for="file in item.preview.modified"
                  :key="`~${file}`"
                  class="sync__file"
                >
                  ~ {{ file }}
                </li>
                <li
                  v-for="file in item.preview.added"
                  :key="`+${file}`"
                  class="sync__file"
                >
                  + {{ file }}
                </li>
                <li
                  v-for="file in item.preview.removed"
                  :key="`-${file}`"
                  class="sync__file"
                >
                  - {{ file }}
                </li>
              </ul>
            </li>
          </ul>
        </template>
        <template v-if="report.dependencies.length">
          <h3 class="sync__section sync__section--changed">
            Also installed · {{ report.dependencies.length }}
          </h3>
          <ul class="sync__list fade-in">
            <li
              v-for="item in report.dependencies"
              :key="`${item.type}:${item.name}`"
              class="sync__item sync__item--changed"
            >
              <span class="sync__name">{{ item.name }}</span>
              <span class="sync__detail">was not installed · required by {{ item.requiredBy.join(", ") }}</span>
            </li>
          </ul>
        </template>
        <template v-if="report.unmanaged.length">
          <h3 class="sync__section">
            Left alone · {{ report.unmanaged.length }}
          </h3>
          <ul class="sync__list">
            <li
              v-for="item in report.unmanaged"
              :key="item.dest"
              class="sync__item sync__item--quiet"
            >
              <span class="sync__name">{{ item.name }}</span>
              <span class="sync__detail">Loadout didn't install the copy at {{ item.dest }}</span>
            </li>
          </ul>
        </template>
        <details
          v-if="report.upToDate.length"
          class="sync__unchanged fade-in"
        >
          <summary class="sync__unchanged-summary">
            {{ report.upToDate.length }} entries unchanged
          </summary>
          <ul class="sync__list">
            <li
              v-for="item in report.upToDate"
              :key="`${item.type}:${item.name}`"
              class="sync__item sync__item--quiet"
            >
              <span class="sync__name">{{ item.name }}</span>
            </li>
          </ul>
        </details>
      </template>
    </PageHeader>
  </section>
</template>

<style scoped>
.sync__summary {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  opacity: 0.7;
}
.sync__count {
  font-weight: 600;
  color: var(--accent-bright);
  opacity: 1;
}
.sync__count--quiet {
  color: inherit;
  font-weight: 500;
}
.sync__count--failed {
  color: var(--status-danger-ink);
}
.sync__count--gone {
  color: var(--status-attention-ink);
}
.sync__warning {
  margin: 0.75rem 0 0;
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.sync__section {
  margin: 1.5rem 0 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
}
.sync__section--error {
  color: var(--status-danger-ink);
  opacity: 0.85;
}
.sync__section--changed {
  color: var(--accent-bright);
  opacity: 0.9;
}
.sync__section--gone {
  color: var(--status-attention-ink);
  opacity: 0.85;
}
.sync__note {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  line-height: 1.45;
  opacity: 0.7;
}
.sync__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.sync__item {
  padding: 0.55rem 0.85rem;
  border-radius: 8px;
  background: var(--surface-raised);
  font-size: 0.83rem;
}
.sync__item--error {
  border-left: 3px solid var(--status-danger-ink);
}
.sync__item--changed {
  padding: 0.7rem 0.85rem;
  border-left: 3px solid var(--accent-bright);
  background: var(--accent-tint);
}
.sync__item--drifted {
  border-left-color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.sync__item--gone {
  border-left: 3px solid var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.sync__item--quiet {
  opacity: 0.6;
}
.sync__path {
  margin: 0.3rem 0 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  opacity: 0.7;
  overflow-wrap: anywhere;
}
.sync__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem;
}
.sync__name {
  font-weight: 600;
  margin-right: 0.5rem;
}
.sync__badge {
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent-tint);
}
.sync__badge--warn {
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.sync__detail {
  opacity: 0.7;
  overflow-wrap: anywhere;
}
.sync__files {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
}
.sync__glyph {
  display: inline-block;
  width: 0.8rem;
  font-weight: 700;
}
.sync__file--added {
  color: var(--status-ok-ink);
}
.sync__file--modified {
  color: var(--status-attention-ink);
}
.sync__file--removed {
  color: var(--status-danger-ink);
}
.sync__unchanged {
  margin-top: 1.5rem;
}
.sync__unchanged-summary {
  cursor: pointer;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
  margin-bottom: 0.5rem;
}

.sync__ack {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  margin: 0.75rem 0;
  font-size: 0.85rem;
}
</style>
