<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue";

defineProps<{
  question: string;
  /** the safe choice, focused first and also what Escape does */
  keep: string;
  /** the destructive choice */
  confirm: string;
}>();
const emit = defineEmits<{ keep: []; confirm: [] }>();

const dialog = useTemplateRef<HTMLDialogElement>("dialog");

// Modal, so focus stays inside and the page behind can't be clicked; unmounting closes it.
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog
    ref="dialog"
    class="confirm-dialog"
    @cancel.prevent="emit('keep')"
  >
    <p class="confirm-dialog__question">
      {{ question }}
    </p>
    <div class="confirm-dialog__actions">
      <button
        type="button"
        class="ghost"
        @click="emit('keep')"
      >
        {{ keep }}
      </button>
      <button
        type="button"
        class="danger"
        @click="emit('confirm')"
      >
        {{ confirm }}
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.confirm-dialog {
  max-width: min(26rem, calc(100vw - 2rem));
  padding: 1rem 1.1rem;
  border: 1px solid var(--border-hairline);
  border-radius: 12px;
  background: var(--surface-page);
  color: var(--text-primary);
  box-shadow: 0 8px 24px var(--shadow-float);
}
.confirm-dialog::backdrop {
  background: var(--scrim);
}
.confirm-dialog__question {
  margin: 0 0 1rem;
  line-height: 1.45;
}
.confirm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
