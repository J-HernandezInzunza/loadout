<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { rowsFor, searchRows, type Tab } from "../catalog.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import AppearanceToggle from "./AppearanceToggle.vue";
import BulkInstall from "./BulkInstall.vue";
import BusyIndicator from "./BusyIndicator.vue";
import CatalogSummary from "./CatalogSummary.vue";
import CatalogTabs from "./CatalogTabs.vue";
import EntryList from "./EntryList.vue";
import StatusBanner from "./StatusBanner.vue";

const catalog = useCatalogStore();
const { entries, catalogs, loading, failure, lastPulled, pullWarnings, firstLoad } = storeToRefs(catalog);
const views = useViewStore();

const tab = ref<Tab>({ kind: "all" });
const query = ref("");
/** collapse All to the copies that would actually install */
const hideOverridden = ref(false);

const activeCatalog = computed(() => (tab.value.kind === "catalog" ? tab.value.id : null));
const selectedCatalog = computed(() => catalogs.value.find((c) => c.id === activeCatalog.value) ?? null);
const multiCatalog = computed(() => catalogs.value.length > 1);
/** Where Loadout writes in this milestone: editable, and a file on this machine. */
const writable = (id: string) => catalogs.value.some((c) => c.id === id && c.editable && c.kind === "local");

const rows = computed(() => rowsFor(tab.value, entries.value, hideOverridden.value));
const filtered = computed(() => searchRows(rows.value, query.value));
/** counted across every catalog: a fact about the machine, not about the tab on screen */
const disabledCount = computed(() => entries.value.filter((e) => e.overriddenBy === null && e.disabled).length);
const overriddenCount = computed(() => entries.value.filter((e) => e.overriddenBy !== null).length);

/**
 * Names ticked for a bulk action, or null when not selecting; only inside one catalog's tab, where "these
 * entries" is unambiguous. Computed over the search-filtered rows.
 */
const picked = ref<Set<string> | null>(null);
/** every row in this tab whose name installs this copy */
const selectable = computed(() => filtered.value.filter((r) => r.entry.overriddenBy === null).map((r) => r.entry.name));
const pickedNames = computed(() => selectable.value.filter((name) => picked.value?.has(name)));

function togglePicked(name: string) {
  if (!picked.value) return;
  const next = new Set(picked.value);
  if (!next.delete(name)) next.add(name);
  picked.value = next;
}

// Null, not empty: an empty set *is* selection mode, and changing tabs leaves it.
watch(tab, () => (picked.value = null));

/** A disabled copy is still on the machine, so it counts as installed and as disabled. */
const summary = computed(() => {
  const installed = filtered.value.filter((r) => r.entry.installed).length;
  const disabled = filtered.value.filter((r) => r.entry.disabled).length;
  const overridden = filtered.value.filter((r) => r.entry.overriddenBy !== null).length;
  const parts = [`${filtered.value.length} of ${rows.value.length} entries`, `${installed} installed`];
  if (disabled) parts.push(`${disabled} disabled`);
  if (overridden) parts.push(`${overridden} overridden`);
  return parts.join(" · ");
});

/**
 * Leaves a tab that stopped existing: the disabled tab once nothing is off, a catalog tab once it is
 * unregistered. Not after a failed load, which empties the lists without meaning either.
 */
watch([disabledCount, catalogs], () => {
  if (failure.value) return;
  const current = tab.value;
  const gone = current.kind === "disabled" ? disabledCount.value === 0 : current.kind === "catalog" && !catalogs.value.some((c) => c.id === current.id);
  if (gone) tab.value = { kind: "all" };
});

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
</script>

<template>
  <!-- The one view with nowhere to go back to, so its head is its title and what you do to the list. -->
  <section class="view">
    <header class="view__head column">
      <div class="view__title">
        <h1>Loadout</h1>
        <AppearanceToggle />
      </div>
      <form
        class="searchbar"
        role="search"
        @submit.prevent
      >
        <input
          v-model="query"
          type="search"
          aria-label="Search skills, agents and prompts"
          placeholder="Search skills, agents, prompts…"
        >
        <!-- Asking for fresh, so this pulls; every other read doesn't. -->
        <button
          type="button"
          class="ghost"
          @click="catalog.refresh()"
        >
          Refresh
        </button>
        <button
          type="button"
          class="ghost"
          @click="views.manage = { catalog: null, entry: null }"
        >
          Catalogs
        </button>
        <button
          type="button"
          class="ghost"
          @click="views.sync = true"
        >
          Sync
        </button>
      </form>
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
      <!-- Shown for the disabled tab too, so a one-catalog setup still has somewhere to find what is off. -->
      <CatalogTabs
        v-if="multiCatalog || disabledCount"
        v-model="tab"
        :catalogs="catalogs"
        :disabled-count="disabledCount"
      />
      <CatalogSummary
        v-if="selectedCatalog"
        :catalog="selectedCatalog"
        :manageable="writable(selectedCatalog.id)"
        @manage="views.manage = { catalog: selectedCatalog.id, entry: null }"
      />
      <p
        v-if="!firstLoad && !failure"
        class="summary"
      >
        {{ summary }}
        <span
          v-if="freshness"
          class="summary__freshness"
        >{{ freshness }}</span>
        <label
          v-if="tab.kind === 'all' && overriddenCount"
          class="summary__toggle"
        >
          <input
            v-model="hideOverridden"
            type="checkbox"
          >
          Hide overridden
        </label>
        <!-- A missing control reads as a bug, so a tab where nothing would install says so. -->
        <span
          v-if="activeCatalog && !selectable.length && rows.length"
          class="summary__note"
        >
          Nothing here can be installed: every copy is overridden by a higher-precedence catalog, so installing any of
          these names would fetch that catalog's copy instead.
        </span>
        <span
          v-if="activeCatalog && selectable.length"
          class="summary__actions"
        >
          <button
            v-if="!picked"
            type="button"
            class="ghost btn-xs"
            @click="picked = new Set()"
          >
            Install or remove several
          </button>
          <template v-else>
            <button
              v-if="pickedNames.length < selectable.length"
              type="button"
              class="ghost btn-xs"
              @click="picked = new Set(selectable)"
            >
              Select all {{ selectable.length }}
            </button>
            <button
              v-if="pickedNames.length"
              type="button"
              class="ghost btn-xs"
              @click="picked = new Set()"
            >
              Clear
            </button>
            <button
              type="button"
              class="ghost btn-xs"
              @click="picked = null"
            >
              Stop selecting
            </button>
          </template>
        </span>
      </p>
      <!-- Kept for the whole of selection mode: it owns the outcome banner of what was just done. -->
      <BulkInstall
        v-if="activeCatalog && picked"
        :names="pickedNames"
        :catalog-id="activeCatalog"
        @done="picked = new Set()"
      />
      <!-- Only the first load replaces the list; a reload keeps the rows and marks them as being re-read,
           so one changed row doesn't blank and rebuild the whole list. -->
      <BusyIndicator
        v-if="firstLoad"
        label="Reading the catalog…"
      />
      <StatusBanner
        v-else-if="failure"
        kind="error"
        :detail="failure"
      />
      <!-- Two different nothings: a search is fixed by changing it, an empty catalog by filling it. -->
      <div
        v-else-if="!filtered.length"
        class="state"
      >
        <template v-if="rows.length">
          <p class="state__line">
            Nothing here matches <strong>{{ query }}</strong>.
          </p>
          <button
            type="button"
            class="ghost"
            @click="query = ''"
          >
            Clear the search
          </button>
        </template>
        <template v-else-if="activeCatalog">
          <p class="state__line">
            {{ activeCatalog }} has no entries yet.
          </p>
          <button
            v-if="writable(activeCatalog)"
            type="button"
            class="ghost"
            @click="views.addingTo = activeCatalog"
          >
            Add the first one
          </button>
        </template>
        <p
          v-else
          class="state__line"
        >
          No catalog holds an entry yet. <strong>Catalogs</strong> above is where you add one.
        </p>
      </div>
      <EntryList
        v-else
        :class="{ 'is-refreshing': loading }"
        :rows="filtered"
        :catalogs="catalogs"
        :show-origin="multiCatalog"
        :selected="picked"
        @select="views.trail = [$event]"
        @toggle="togglePicked($event)"
      />
    </div>
  </section>
</template>

<style scoped>
h1 {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
}
.view__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.searchbar {
  display: flex;
  gap: 0.5rem;
  margin: 0;
}
.searchbar input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
}
.warning {
  margin: 0;
}
.summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
  opacity: 0.75;
}
.summary__freshness {
  opacity: 0.8;
}
.summary__note {
  flex-basis: 100%;
}
.summary__actions {
  display: flex;
  gap: 0.4rem;
  margin-left: auto;
}
.summary__toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
}
.state {
  padding: 2rem 0;
  text-align: center;
}
.state__line {
  margin: 0 0 0.75rem;
}
.entry-list {
  transition: opacity 0.12s ease;
}
</style>
