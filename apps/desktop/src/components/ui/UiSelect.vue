<script setup lang="ts" generic="T">
// The app's select: the native element, so the menu that opens is the system's own (typeahead,
// accessibility), with the closed field drawn like the app's other controls. Options go in the slot;
// attributes land on the <select>.
defineOptions({ inheritAttrs: false });

const model = defineModel<T>({ required: true });
</script>

<template>
  <span class="ui-select">
    <select
      v-bind="$attrs"
      v-model="model"
      class="ui-select__field"
    >
      <slot />
    </select>
  </span>
</template>

<style scoped>
.ui-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
}
.ui-select__field {
  appearance: none;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 0.3rem 1.8rem 0.3rem 0.6rem;
  border: 1px solid var(--border-control);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-overflow: ellipsis;
  cursor: pointer;
}
.ui-select__field:hover:not(:disabled) {
  border-color: var(--control-on);
}
.ui-select__field:focus-visible {
  outline: 2px solid var(--accent-bright);
  outline-offset: 2px;
}
.ui-select__field:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* The chevron: two borders of a rotated box in the text's colour, so it follows the theme. */
.ui-select::after {
  content: "";
  position: absolute;
  right: 0.7rem;
  top: 50%;
  width: 0.35rem;
  height: 0.35rem;
  border: solid currentColor;
  border-width: 0 1.5px 1.5px 0;
  transform: translateY(-70%) rotate(45deg);
  opacity: 0.6;
  pointer-events: none;
}
</style>
