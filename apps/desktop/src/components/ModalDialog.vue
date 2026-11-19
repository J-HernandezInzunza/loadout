<script setup lang="ts">
import { onMounted, useId, useTemplateRef } from "vue";

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();

const dialog = useTemplateRef<HTMLDialogElement>("dialog");
const titleId = useId();

// Modal, so focus stays inside and the page behind can't be clicked; unmounting closes it.
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
  >
    <h2
      :id="titleId"
      class="modal-dialog__title"
    >
      {{ title }}
    </h2>
    <slot />
  </dialog>
</template>

<style scoped>
.modal-dialog {
  width: min(40rem, calc(100vw - 2rem));
  padding: 1rem 1.1rem;
  border: 1px solid var(--border-hairline);
  border-radius: 12px;
  background: var(--surface-page);
  color: var(--text-primary);
  box-shadow: 0 8px 24px var(--shadow-float);
}
.modal-dialog::backdrop {
  background: var(--scrim);
}
.modal-dialog__title {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}
</style>
