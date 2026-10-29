<script setup lang="ts">
import type { Library } from "@loadout/core";
import { storeToRefs } from "pinia";
import { onMounted, ref } from "vue";
import ActivityBar from "./components/ActivityBar.vue";
import AddEntry from "./components/AddEntry.vue";
import CatalogsView from "./components/CatalogsView.vue";
import CatalogView from "./components/CatalogView.vue";
import CommandLog from "./components/CommandLog.vue";
import DoctorView from "./components/DoctorView.vue";
import EntryDetail from "./components/EntryDetail.vue";
import FirstRun from "./components/FirstRun.vue";
import InstallView from "./components/InstallView.vue";
import ParkedSkills from "./components/ParkedSkills.vue";
import SyncView from "./components/SyncView.vue";
import ToastStack from "./components/ToastStack.vue";
import { useLibrary } from "./services.ts";
import { useCatalogStore } from "./stores/catalog.ts";
import { useViewStore } from "./stores/views.ts";

const catalog = useCatalogStore();
const views = useViewStore();
const { current } = storeToRefs(views);
const { unregistered } = storeToRefs(catalog);
const library = useLibrary();

type MigratePlan = Extract<Awaited<ReturnType<Library["planMigrateParked"]>>, { ok: true }>["value"];
/** what the Python CLI parked, shown before it moves back; only while at least one copy can */
const parked = ref<MigratePlan | null>(null);

onMounted(async () => {
  await catalog.launch();
  const planned = await library.planMigrateParked();
  if (planned.ok && planned.value.items.some((item) => !item.occupied)) parked.value = planned.value;
});
</script>

<template>
  <main class="app">
    <ActivityBar />
    <!-- Nothing registered: nothing below has anything to show until one catalog is. -->
    <FirstRun v-if="unregistered" />
    <ParkedSkills
      v-else-if="parked"
      :plan="parked"
      @done="parked = null"
    />
    <CatalogView v-else-if="current.kind === 'list'" />
    <DoctorView
      v-else-if="current.kind === 'doctor'"
      :back="views.manage ? 'Catalogs' : 'Loadout'"
    />
    <SyncView v-else-if="current.kind === 'sync'" />
    <CatalogsView
      v-else-if="current.kind === 'catalogs'"
      :at="current.catalog"
      :back="views.trail.at(-1)?.name ?? 'Loadout'"
    />
    <EntryDetail
      v-else-if="current.kind === 'entry'"
      :stop="current.stop"
      :back="current.back?.name ?? 'Loadout'"
    />
    <!-- Above the entry page it opens from, so Back lands there. -->
    <InstallView
      v-else-if="current.kind === 'install'"
      :name="current.name"
      :back="views.trail.at(-1)?.name ?? 'Loadout'"
    />
    <AddEntry
      v-else-if="current.kind === 'add'"
      :catalog-id="current.catalog"
    />
    <!-- Over the view rather than in it, so a notice never pushes the list around. -->
    <ToastStack />
    <!-- The app's last row, under whichever view is on screen. -->
    <CommandLog />
  </main>
</template>

<style scoped>
/* The view, then the command bar: exactly the window tall, so the bar is its bottom by construction. */
.app {
  height: 100%;
  display: grid;
  grid-template-rows: 1fr auto;
  /* the containing block for the toast stack, positioned into row 1 */
  position: relative;
}
</style>
