<script setup lang="ts">
import type { CatalogRow } from "@loadout/core";
import { catalogHue, writeModeText } from "../catalog.ts";

defineProps<{
  catalog: CatalogRow;
  /** whether to offer managing its entries: the caller applies the same gate the catalog manager does */
  manageable: boolean;
}>();
const emit = defineEmits<{ manage: [] }>();
</script>

<template>
  <section
    class="catalog-summary"
    :style="{ '--catalog-hue': catalogHue(catalog.precedence) }"
  >
    <div class="catalog-summary__line">
      <p class="catalog-summary__meta">
        <span class="catalog-summary__rank">precedence {{ catalog.precedence }}</span>
        <span>{{ catalog.kind }}</span>
        <span>{{ writeModeText(catalog) }}</span>
        <span class="catalog-summary__location">{{ catalog.location }}</span>
      </p>
      <!-- Absent rather than disabled where Loadout won't write: the write mode beside it is the reason. -->
      <button
        v-if="manageable"
        type="button"
        class="ghost btn-xs catalog-summary__manage"
        @click="emit('manage')"
      >
        Manage entries
      </button>
    </div>

    <p
      v-if="catalog.skipped"
      class="catalog-summary__skipped"
    >
      This catalog was skipped, so nothing below comes from it:
      {{ catalog.skipped }}
    </p>
  </section>
</template>

<style scoped>
.catalog-summary {
  padding: 0.6rem 0.8rem;
  border-left: 3px solid var(--catalog-edge);
  border-radius: 0 8px 8px 0;
  background: var(--catalog-wash);
}
.catalog-summary__line {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  /* One btn-xs tall on every tab, so the strip doesn't jump when "Manage entries" is absent. */
  min-height: 1.4rem;
}
.catalog-summary__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0;
  min-width: 0;
  font-size: 0.78rem;
  opacity: 0.75;
}
.catalog-summary__rank {
  font-weight: 600;
  opacity: 0.9;
}
.catalog-summary__location {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.72rem;
  /* A path has no break opportunities of its own. */
  overflow-wrap: anywhere;
}
.catalog-summary__manage {
  flex: none;
  margin-left: auto;
}
.catalog-summary__skipped {
  margin: 0.5rem 0 0;
  font-size: 0.82rem;
  color: var(--status-attention-ink);
}
</style>
