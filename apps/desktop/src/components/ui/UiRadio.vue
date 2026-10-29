<script setup lang="ts" generic="T">
// The app's radio button: the native input, kept for arrow-key movement within its group, drawn to match
// the on/off switch. Attributes land on the input; a surrounding <label> labels it.
defineOptions({ inheritAttrs: false });

const model = defineModel<T>({ required: true });
defineProps<{ value: T }>();
</script>

<template>
  <input
    v-bind="$attrs"
    v-model="model"
    type="radio"
    class="ui-radio"
    :value="value"
  >
</template>

<style scoped>
.ui-radio {
  appearance: none;
  flex: none;
  margin: 0;
  width: 1rem;
  height: 1rem;
  border: 1px solid var(--control-off);
  border-radius: 50%;
  background: transparent;
  vertical-align: middle;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}
.ui-radio:hover:not(:disabled) {
  border-color: var(--control-on);
}
/* The dot: the on colour inside a ring of the page, drawn with shadows so no image is needed. */
.ui-radio:checked {
  border-color: var(--control-on);
  background: var(--control-on);
  box-shadow: inset 0 0 0 3px var(--surface-page);
}
.ui-radio:focus-visible {
  outline: 2px solid var(--accent-bright);
  outline-offset: 2px;
}
.ui-radio:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
