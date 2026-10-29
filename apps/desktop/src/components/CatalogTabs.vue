<script setup lang="ts">
import type { CatalogRow } from "@loadout/core";
import { catalogHue, type Tab } from "../catalog.ts";

defineProps<{
  catalogs: CatalogRow[];
  /** how many entries are switched off, across every catalog */
  disabledCount: number;
}>();

const active = defineModel<Tab>({ required: true });
</script>

<template>
  <nav
    class="catalog-tabs"
    aria-label="Catalogs"
  >
    <button
      type="button"
      class="catalog-tabs__tab"
      :class="{ 'catalog-tabs__tab--active': active.kind === 'all' }"
      :aria-pressed="active.kind === 'all'"
      @click="active = { kind: 'all' }"
    >
      All
    </button>

    <button
      v-for="catalog in catalogs"
      :key="catalog.id"
      type="button"
      class="catalog-tabs__tab"
      :class="{
        'catalog-tabs__tab--active': active.kind === 'catalog' && active.id === catalog.id,
        'catalog-tabs__tab--skipped': !!catalog.skipped,
      }"
      :aria-pressed="active.kind === 'catalog' && active.id === catalog.id"
      :style="{ '--catalog-hue': catalogHue(catalog.precedence) }"
      @click="active = { kind: 'catalog', id: catalog.id }"
    >
      <span class="catalog-tabs__dot" />
      {{ catalog.id }}
      <!-- A skipped catalog has no count, and 0 would read as "nothing shared". -->
      <span class="catalog-tabs__count">{{ catalog.skipped ? "—" : catalog.entries }}</span>
    </button>

    <!-- Set apart at the far end: the others cut the list by where an entry came from, this one by its
         state. Absent while nothing is off, since a tab that can only show an empty list is a dead end. -->
    <template v-if="disabledCount">
      <span
        class="catalog-tabs__divider"
        aria-hidden="true"
      />
      <button
        type="button"
        class="catalog-tabs__tab catalog-tabs__tab--off"
        :class="{ 'catalog-tabs__tab--active': active.kind === 'disabled' }"
        :aria-pressed="active.kind === 'disabled'"
        @click="active = { kind: 'disabled' }"
      >
        <span class="catalog-tabs__dot" />
        disabled
        <span class="catalog-tabs__count">{{ disabledCount }}</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.catalog-tabs {
  display: flex;
  gap: 0.35rem;
  border-bottom: 1px solid var(--border-hairline);
}
.catalog-tabs__tab {
  --catalog-hue: 220;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.8rem;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: inherit;
  font-size: 0.9rem;
  font-weight: 500;
  opacity: 0.65;
}
.catalog-tabs__tab:hover {
  background: var(--surface-raised);
  opacity: 0.9;
}
.catalog-tabs__tab--active {
  border-bottom-color: var(--catalog-edge);
  opacity: 1;
}
.catalog-tabs__tab--skipped {
  text-decoration: line-through;
}
.catalog-tabs__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--catalog-edge);
}
/* "All" has no catalog of its own, so no colour. */
.catalog-tabs__tab:first-child .catalog-tabs__dot {
  display: none;
}
.catalog-tabs__divider {
  margin-left: auto;
  align-self: center;
  /* A 1px flex item is the first thing a crowded strip shrinks away. */
  flex: none;
  width: 1px;
  height: 1rem;
  background: var(--border-control);
}
.catalog-tabs__tab--off .catalog-tabs__dot {
  background: var(--status-disabled-ink);
}
.catalog-tabs__tab--off.catalog-tabs__tab--active {
  border-bottom-color: var(--status-disabled-ink);
}
.catalog-tabs__count {
  font-size: 0.75rem;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
</style>
