<script setup lang="ts">
import type { Row } from "../catalog.ts";

defineProps<{ tone: Row["tone"] }>();
</script>

<!-- Every place that says whether a copy is on the machine draws it with this, so one state is one colour. -->
<template>
  <span
    class="status-chip"
    :class="`status-chip--${tone}`"
  ><slot /></span>
</template>

<style scoped>
.status-chip {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  white-space: nowrap;
}
.status-chip--installed {
  background: var(--status-ok-tint);
  color: var(--status-ok-ink);
}
.status-chip--absent {
  background: var(--surface-sunken);
  opacity: 0.8;
}
.status-chip--disabled {
  background: var(--status-disabled-tint);
  color: var(--status-disabled-ink);
}
.status-chip--attention {
  background: var(--status-attention-tint);
  color: var(--status-attention-ink);
  font-weight: 600;
}
</style>
