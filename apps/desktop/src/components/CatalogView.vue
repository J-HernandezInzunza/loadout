<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { rowsFor, searchRows } from "../catalog.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useListStore } from "../stores/list.ts";
import { useViewStore } from "../stores/views.ts";
import BulkInstall from "./BulkInstall.vue";
import BusyIndicator from "./BusyIndicator.vue";
import CatalogSummary from "./CatalogSummary.vue";
import EntryList from "./EntryList.vue";
import ListSidebar from "./ListSidebar.vue";
import StatusBanner from "./StatusBanner.vue";

const catalog = useCatalogStore();
const { entries, catalogs, loading, failure, lastPulled, pullWarnings, firstLoad } = storeToRefs(catalog);
const views = useViewStore();
const { type, from, state, hideOverridden, query } = storeToRefs(useListStore());

const selectedCatalog = computed(() => catalogs.value.find((c) => c.id === from.value) ?? null);
const multiCatalog = computed(() => catalogs.value.length > 1);
const writable = (id: string) => catalogs.value.some((c) => c.id === id && c.editable);

/** the select's value: "" stands for every catalog */
const fromChoice = computed({
  get: () => from.value ?? "",
  set: (id: string) => (from.value = id || null),
});
const title = computed(() => (type.value === null ? "All" : `${type.value[0]!.toUpperCase()}${type.value.slice(1)}s`));
/** what the rows are called in counts and empty states */
const noun = computed(() => (type.value === null ? "entries" : `${type.value}s`));

const rows = computed(() => rowsFor({ type: type.value, from: from.value, state: state.value, hideOverridden: hideOverridden.value }, entries.value));
const filtered = computed(() => searchRows(rows.value, query.value));
/** counted across every catalog: a fact about the machine, not about the filter on screen */
const disabledCount = computed(() => entries.value.filter((e) => e.overriddenBy === null && e.disabled).length);
const overriddenCount = computed(() => entries.value.filter((e) => e.overriddenBy !== null).length);

/**
 * Names ticked for a bulk action, or null when not selecting; only with one catalog in From, where "these
 * entries" is unambiguous. Computed over the search-filtered rows.
 */
const picked = ref<Set<string> | null>(null);
/** every row shown whose name installs this copy */
const selectable = computed(() => filtered.value.filter((r) => r.entry.overriddenBy === null).map((r) => r.entry.name));
const pickedNames = computed(() => selectable.value.filter((name) => picked.value?.has(name)));

function togglePicked(name: string) {
  if (!picked.value) return;
  const next = new Set(picked.value);
  if (!next.delete(name)) next.add(name);
  picked.value = next;
}

// Null, not empty: an empty set *is* selection mode, and changing what is shown leaves it.
watch([type, from, state], () => (picked.value = null));

/** A disabled copy is still on the machine, so it counts as installed and as disabled. */
const summary = computed(() => {
  const installed = filtered.value.filter((r) => r.entry.installed).length;
  const disabled = filtered.value.filter((r) => r.entry.disabled).length;
  const overridden = filtered.value.filter((r) => r.entry.overriddenBy !== null).length;
  const parts = [`${filtered.value.length} of ${rows.value.length} ${noun.value}`, `${installed} installed`];
  if (disabled) parts.push(`${disabled} disabled`);
  if (overridden) parts.push(`${overridden} overridden`);
  return parts.join(" · ");
});

/** Why there is nothing to show when the search isn't the reason. */
const emptyLine = computed(() => {
  if (from.value !== null) {
    return state.value === "installed" ? `None of ${from.value}'s ${noun.value} is installed.` : `${from.value} has no ${noun.value} yet.`;
  }
  if (state.value === "installed") return `No ${noun.value} installed yet.`;
  return `No catalog holds any ${noun.value} yet.`;
});

/**
 * Leaves a choice that stopped existing: Disabled once nothing is off, a catalog once it is unregistered.
 * Not after a failed load, which empties the lists without meaning either.
 */
watch([disabledCount, catalogs], () => {
  if (failure.value) return;
  if (state.value === "disabled" && disabledCount.value === 0) state.value = "any";
  if (from.value !== null && !catalogs.value.some((c) => c.id === from.value)) from.value = null;
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
  <!-- The one view with nowhere to go back to: the sidebar is where the rest of the app is. -->
  <section class="view list-view">
    <ListSidebar class="list-view__side" />
    <header class="view__head column">
      <h1>{{ title }}</h1>
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
      </form>
      <div
        v-if="catalogs.length"
        class="toolbar"
      >
        <label class="toolbar__from">
          From
          <select v-model="fromChoice">
            <option value="">every catalog</option>
            <option
              v-for="c in catalogs"
              :key="c.id"
              :value="c.id"
            >
              {{ c.id }} ({{ c.skipped ? "not loaded" : c.entries }})
            </option>
          </select>
        </label>
        <div
          class="toolbar__state"
          role="group"
          aria-label="Show"
        >
          <button
            type="button"
            :aria-pressed="state === 'any'"
            @click="state = 'any'"
          >
            Any
          </button>
          <button
            type="button"
            :aria-pressed="state === 'installed'"
            @click="state = 'installed'"
          >
            Installed
          </button>
          <!-- Absent while nothing is off: a choice that can only show an empty list is a dead end. -->
          <button
            v-if="disabledCount"
            type="button"
            :aria-pressed="state === 'disabled'"
            @click="state = 'disabled'"
          >
            Disabled {{ disabledCount }}
          </button>
        </div>
        <label
          v-if="from === null && state === 'any' && overriddenCount"
          class="toolbar__toggle"
        >
          <input
            v-model="hideOverridden"
            type="checkbox"
          >
          Hide overridden
        </label>
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
        <!-- A missing control reads as a bug, so a catalog where nothing would install says so. -->
        <span
          v-if="from && !selectable.length && rows.length"
          class="summary__note"
        >
          Nothing here can be installed: every copy is overridden by a higher-precedence catalog, so installing any of
          these names would fetch that catalog's copy instead.
        </span>
        <span
          v-if="from && selectable.length"
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
        v-if="from && picked"
        :names="pickedNames"
        :catalog-id="from"
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
        <p
          v-else-if="!entries.length"
          class="state__line"
        >
          No catalog holds an entry yet. <strong>Catalogs</strong> in the sidebar is where you add one.
        </p>
        <template v-else>
          <p class="state__line">
            {{ emptyLine }}
          </p>
          <button
            v-if="from && state === 'any' && writable(from)"
            type="button"
            class="ghost"
            @click="views.addingTo = from"
          >
            Add the first one
          </button>
        </template>
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
/* The sidebar spans the view's rows; the head and the scrolling body sit beside it. */
.list-view {
  grid-template-columns: 12.5rem minmax(0, 1fr);
}
.list-view__side {
  grid-column: 1;
  grid-row: 1 / -1;
}
.list-view > .view__head,
.list-view > .view__body {
  grid-column: 2;
}
h1 {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 0.6rem;
  font-size: 0.85rem;
}
.toolbar__from {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.toolbar__from select {
  padding: 0.25rem 0.4rem;
  border-radius: 6px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font: inherit;
}
.toolbar__state {
  display: inline-flex;
  border: 1px solid var(--border-control);
  border-radius: 8px;
  overflow: hidden;
}
.toolbar__state button {
  padding: 0.25rem 0.7rem;
  border: none;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
}
.toolbar__state button + button {
  border-left: 1px solid var(--border-hairline);
}
.toolbar__state button[aria-pressed="true"] {
  background: var(--surface-hover);
  font-weight: 600;
}
.toolbar__toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
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
