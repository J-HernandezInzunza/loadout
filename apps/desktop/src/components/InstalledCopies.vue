<script setup lang="ts">
import type { EntryRecord } from "@loadout/core";
import { computed } from "vue";

const props = defineProps<{
  /** the page's entry with the install fields of its destination */
  entry: EntryRecord;
}>();

/**
 * What sits at the entry's destination: Loadout installs globally, so there is at most one. The receipt
 * says which catalog's copy it is, the one fact that tells two catalogs' copies apart once on disk.
 */
const copies = computed(() =>
  props.entry.locations.map((dest) => ({
    dest,
    fromCatalog: props.entry.receipt?.catalog.id ?? null,
    managed: props.entry.receipt !== null,
  })),
);
</script>

<template>
  <section class="copies">
    <h3 class="copies__heading">
      On this machine ({{ copies.length }})
    </h3>

    <p
      v-if="!copies.length"
      class="copies__none"
    >
      Not installed anywhere yet. Installing puts a copy in your Claude directory; the catalog entry above
      is only a pointer to where it comes from.
    </p>

    <ul
      v-else
      class="copies__list"
    >
      <li
        v-for="copy in copies"
        :key="copy.dest"
        class="copies__item"
      >
        <div class="copies__line">
          <code class="copies__dest">{{ copy.dest }}</code>
          <span
            v-if="!copy.managed"
            class="copies__unmanaged"
          >
            Loadout didn't install this copy, so it has no record of what it holds
          </span>
          <!-- Silent when they agree, the common case. -->
          <span
            v-else-if="copy.fromCatalog !== entry.catalog"
            class="copies__foreign"
          >
            from {{ copy.fromCatalog }}, not {{ entry.catalog }}
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.copies__heading {
  margin: 1.5rem 0 0.5rem;
  font-size: 0.95rem;
}
.copies__none {
  margin: 0;
  font-size: 0.88rem;
  opacity: 0.75;
}
.copies__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.copies__item {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  background: var(--surface-raised);
}
.copies__line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.copies__dest {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.copies__unmanaged,
.copies__foreign {
  font-size: 0.75rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--status-attention-tint);
  color: var(--status-attention-ink);
}
</style>
