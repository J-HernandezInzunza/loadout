<script setup lang="ts" generic="T">
// The app's checkbox: the native input, kept for keyboard, focus and form behaviour, drawn to match the
// on/off switch. Attributes (id, disabled, aria-*) land on the input; a surrounding <label> labels it.
defineOptions({ inheritAttrs: false });

/** a boolean on its own, or the list of ticked values when `value` is set */
const model = defineModel<boolean | T[]>({ required: true });
defineProps<{ value?: T }>();
</script>

<template>
  <span class="ui-checkbox">
    <input
      v-bind="$attrs"
      v-model="model"
      type="checkbox"
      class="ui-checkbox__input"
      :value="value"
    >
    <span
      class="ui-checkbox__mark"
      aria-hidden="true"
    />
  </span>
</template>

<style scoped>
.ui-checkbox {
  position: relative;
  display: inline-flex;
  flex: none;
  vertical-align: middle;
}
.ui-checkbox__input {
  appearance: none;
  box-sizing: border-box;
  margin: 0;
  width: 1rem;
  height: 1rem;
  border: 1px solid var(--control-off);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}
.ui-checkbox__input:hover:not(:disabled) {
  border-color: var(--control-on);
}
.ui-checkbox__input:checked {
  background: var(--control-on);
  border-color: var(--control-on);
}
.ui-checkbox__input:focus-visible {
  outline: 2px solid var(--accent-bright);
  outline-offset: 2px;
}
.ui-checkbox__input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* The tick: two borders of a rotated box, so it takes the theme's knob colour with no image. Centred on the
   box, then raised a little, because a tick's weight sits in its lower stroke. */
.ui-checkbox__mark {
  position: absolute;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  width: 0.34rem;
  height: 0.6rem;
  border: solid var(--control-on-knob);
  border-width: 0 2px 2px 0;
  transform: translate(-50%, -60%) rotate(45deg);
  opacity: 0;
  pointer-events: none;
}
.ui-checkbox__input:checked + .ui-checkbox__mark {
  opacity: 1;
}
</style>
