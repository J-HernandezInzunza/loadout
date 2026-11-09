<script setup lang="ts">
import type { EntryType } from "@loadout/core";
import { useId } from "vue";
import TypeDot from "./TypeDot.vue";

defineProps<{
  type: EntryType;
  title: string;
  count: number;
  /** what an empty column says instead of its members */
  empty: string;
}>();

const titleId = useId();
</script>

<template>
  <div
    class="type-column"
    :class="`type-column--${type}`"
    role="group"
    :aria-labelledby="titleId"
  >
    <div class="type-column__head">
      <TypeDot :type="type" />
      <span
        :id="titleId"
        class="type-column__title"
      >{{ title }}</span>
      <span class="type-column__count">{{ count }}</span>
      <span class="type-column__action"><slot name="action" /></span>
    </div>
    <p
      v-if="count === 0"
      class="type-column__empty"
    >
      {{ empty }}
    </p>
    <slot v-else />
  </div>
</template>

<style scoped>
.type-column {
  min-width: 0;
  padding: 0.45rem 0.65rem 0.3rem;
  border: 1px solid transparent;
  border-radius: 8px;
}
.type-column--skill {
  background: var(--type-skill-tint);
  border-color: var(--type-skill-edge);
}
.type-column--agent {
  background: var(--type-agent-tint);
  border-color: var(--type-agent-edge);
}
.type-column--prompt {
  background: var(--type-prompt-tint);
  border-color: var(--type-prompt-edge);
}
.type-column__head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}
.type-column__title {
  font-size: 0.85rem;
  font-weight: 600;
}
.type-column__count {
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
.type-column__action {
  margin-left: auto;
}
.type-column__empty {
  margin: 0.4rem 0 0.25rem;
  font-size: 0.78rem;
  opacity: 0.7;
}
</style>
