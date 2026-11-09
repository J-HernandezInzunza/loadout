<script setup lang="ts">
import type { EntryType } from "@loadout/core";

defineProps<{ type: EntryType }>();
</script>

<template>
  <span
    class="type-dot"
    :class="`type-dot--${type}`"
    aria-hidden="true"
  />
</template>

<style scoped>
.type-dot {
  display: inline-block;
  flex: none;
  align-self: center;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
}
.type-dot--skill {
  background: var(--type-skill-mark);
}
.type-dot--agent {
  background: var(--type-agent-mark);
}
.type-dot--prompt {
  background: var(--type-prompt-mark);
}
</style>
