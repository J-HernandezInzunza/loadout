<script setup lang="ts">
import { clashShort, clashText, type Clash } from "../loadouts.ts";

defineProps<{ clash: Clash }>();
</script>

<template>
  <!-- The short form for a narrow column; the sentence on hover, and for a screen reader. -->
  <p
    class="clash-line"
    :title="clashText(clash)"
  >
    <span
      class="clash-line__short"
      aria-hidden="true"
    >{{ clashShort(clash) }}</span>
    <span class="clash-line__full">{{ clashText(clash) }}</span>
  </p>
</template>

<style scoped>
.clash-line {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--status-attention-ink);
  overflow-wrap: anywhere;
  cursor: help;
}
.clash-line__full {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
