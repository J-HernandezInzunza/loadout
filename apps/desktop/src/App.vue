<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onMounted } from "vue";
import ActivityBar from "./components/ActivityBar.vue";
import CatalogsView from "./components/CatalogsView.vue";
import CatalogView from "./components/CatalogView.vue";
import CommandLog from "./components/CommandLog.vue";
import DoctorView from "./components/DoctorView.vue";
import EntryDetail from "./components/EntryDetail.vue";
import InstallView from "./components/InstallView.vue";
import PageHeader from "./components/PageHeader.vue";
import SyncView from "./components/SyncView.vue";
import ToastStack from "./components/ToastStack.vue";
import { useCatalogStore } from "./stores/catalog.ts";
import { useViewStore } from "./stores/views.ts";

const catalog = useCatalogStore();
const views = useViewStore();
const { current } = storeToRefs(views);

onMounted(() => catalog.launch());
</script>

<template>
  <main class="app">
    <ActivityBar />
    <CatalogView v-if="current.kind === 'list'" />
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
    <!-- A stand-in for the views still to come, so opening one never strands the window. -->
    <section
      v-else
      class="view"
    >
      <PageHeader
        :title="current.kind"
        back="Loadout"
        @back="views.home()"
      >
        <p>This view isn't built yet.</p>
      </PageHeader>
    </section>
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
