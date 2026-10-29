<script setup lang="ts">
import type { Library } from "@loadout/core";
import { computed, ref } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import BusyIndicator from "./BusyIndicator.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";

type Settled<K extends "planMigrateParked" | "applyMigrateParked"> = Extract<Awaited<ReturnType<Library[K]>>, { ok: true }>["value"];

const props = defineProps<{ plan: Settled<"planMigrateParked"> }>();
const emit = defineEmits<{ done: [] }>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();

const moving = ref(false);
const failure = ref<string | null>(null);
const report = ref<Settled<"applyMigrateParked"> | null>(null);

const movable = computed(() => props.plan.items.filter((item) => !item.occupied).length);

async function moveBack() {
  moving.value = true;
  failure.value = null;
  const migrated = await activity.withActivity("moving parked skills back…", () => library.applyMigrateParked(props.plan));
  moving.value = false;
  if (!migrated.ok) {
    failure.value = migrated.error.message;
    return;
  }
  report.value = migrated.value;
  // The moved copies are installed again (and off), which the list should show when it comes back.
  await catalog.reload();
}
</script>

<template>
  <section class="view parked">
    <PageHeader title="Skills the Python CLI turned off">
      <p class="parked__lead">
        The Python CLI turned skills off by moving them to <code>~/.claude/skills-disabled</code>. Loadout turns them
        off in Claude Code's settings instead, so it moves each one back to <code>~/.claude/skills</code> and keeps it
        off. Turn any of them on from the list afterwards.
      </p>

      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      >
        <p>Nothing was moved.</p>
      </StatusBanner>

      <template v-if="report">
        <StatusBanner
          v-if="report.moved.length"
          kind="success"
        >
          <p class="parked__moved">
            Moved back and kept off: {{ report.moved.join(", ") }}
          </p>
        </StatusBanner>
        <StatusBanner
          v-if="report.leftInPlace.length"
          kind="warning"
        >
          <p>Left where the Python CLI put them:</p>
          <ul class="parked__list parked__left">
            <li
              v-for="item in report.leftInPlace"
              :key="item.name"
            >
              <strong>{{ item.name }}</strong> — {{ item.reason }}
            </li>
          </ul>
        </StatusBanner>
      </template>

      <ul
        v-else
        class="parked__list parked__items card"
      >
        <li
          v-for="item in plan.items"
          :key="item.name"
        >
          <strong>{{ item.name }}</strong>
          <template v-if="item.occupied">
            — stays parked: <code>{{ item.to }}</code> is already taken
          </template>
        </li>
      </ul>

      <div class="parked__actions">
        <button
          v-if="!report"
          type="button"
          :disabled="moving"
          @click="moveBack"
        >
          {{ movable === 1 ? "Move it back and keep it off" : `Move ${movable} back and keep them off` }}
        </button>
        <button
          v-if="report || failure"
          type="button"
          :class="{ ghost: !report }"
          @click="emit('done')"
        >
          Continue
        </button>
      </div>
      <BusyIndicator
        v-if="moving"
        inline
        label="Moving the skills back…"
      />
    </PageHeader>
  </section>
</template>

<style scoped>
.parked__lead {
  margin: 0 0 1rem;
  line-height: 1.5;
  opacity: 0.85;
}
.parked__list {
  margin: 0 0 1rem;
  padding-left: 1.2rem;
  font-size: 0.85rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.parked__items {
  padding-left: 2rem;
}
.parked__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}
.parked code {
  font-size: 0.85em;
}
</style>
