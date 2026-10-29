<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref } from "vue";
import ActivityBar from "./components/ActivityBar.vue";
import AppearanceToggle from "./components/AppearanceToggle.vue";
import BusyIndicator from "./components/BusyIndicator.vue";
import StatusBanner from "./components/StatusBanner.vue";
import ToastStack from "./components/ToastStack.vue";
import { useCatalogStore } from "./stores/catalog.ts";
import { useViewStore } from "./stores/views.ts";

const catalog = useCatalogStore();
const { entries, loading, failure, lastPulled, pullWarnings, firstLoad } = storeToRefs(catalog);
const { current } = storeToRefs(useViewStore());

// Ticks so the freshness cue ages on screen: "how old is this?" is the question it answers.
const now = ref(new Date());
const ticking = setInterval(() => (now.value = new Date()), 60_000);
onUnmounted(() => clearInterval(ticking));

const freshness = computed(() => {
  if (!lastPulled.value) return null;
  const minutes = Math.floor((now.value.getTime() - lastPulled.value.getTime()) / 60_000);
  if (minutes < 1) return "refreshed just now";
  if (minutes === 1) return "refreshed 1 minute ago";
  if (minutes < 60) return `refreshed ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "refreshed 1 hour ago" : `refreshed ${hours} hours ago`;
});

onMounted(() => catalog.launch());
</script>

<template>
  <main class="app">
    <ActivityBar />
    <!-- The catalog list: the one view with nowhere to go back to, so its head is its title and what
         you do to the list rather than a back row. -->
    <section
      v-if="current.kind === 'list'"
      class="view"
    >
      <header class="view__head column">
        <div class="view__title">
          <h1>Loadout</h1>
          <AppearanceToggle />
        </div>
        <div class="toolbar">
          <!-- Asking for fresh, so this pulls; every other read doesn't. -->
          <button
            type="button"
            class="ghost"
            @click="catalog.refresh()"
          >
            Refresh
          </button>
        </div>
      </header>
      <div class="view__body column stack">
        <StatusBanner
          v-if="pullWarnings.length"
          kind="warning"
        >
          <p
            v-for="warning in pullWarnings"
            :key="warning"
            class="warning"
          >
            {{ warning }}
          </p>
        </StatusBanner>
        <p
          v-if="freshness && !failure"
          class="summary"
        >
          <span class="summary__freshness">{{ freshness }}</span>
        </p>
        <!-- Only the first load replaces the list; a reload keeps the rows and marks them as being
             re-read, so one changed row doesn't blank and rebuild the whole list. -->
        <BusyIndicator
          v-if="firstLoad"
          label="Reading the catalog…"
        />
        <StatusBanner
          v-else-if="failure"
          kind="error"
          :detail="failure"
        />
        <ul
          v-else
          class="entry-list"
          :class="{ 'is-refreshing': loading }"
        >
          <li
            v-for="entry in entries"
            :key="`${entry.catalog}:${entry.type}:${entry.name}`"
            class="entry-list__name"
          >
            {{ entry.name }}
          </li>
        </ul>
      </div>
    </section>
    <!-- Over the view rather than in it, so a notice never pushes the list around. -->
    <ToastStack />
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
h1 {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
}
.view__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.toolbar {
  display: flex;
  gap: 0.5rem;
}
.warning {
  margin: 0;
}
.summary {
  font-size: 0.85rem;
  opacity: 0.7;
}
.entry-list {
  margin: 0;
  padding: 0;
  list-style: none;
  transition: opacity 0.12s ease;
}
</style>
