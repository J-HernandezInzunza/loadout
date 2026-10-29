import { defineStore } from "pinia";
import { readonly, ref } from "vue";

export interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
  /** command output or a path, shown small and monospaced under the message */
  detail?: string;
}

/** A failure is unexpected and carries the only copy of the reason, so it stays longer than a success. */
export const LINGER = { success: 4_000, error: 6_000 } as const;

/**
 * Notices over the view, oldest first. A store rather than inline banners, which pushed the list down under
 * the pointer that had just acted on it.
 */
export const useToastStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function notify(toast: Omit<Toast, "id">): number {
    const id = nextId++;
    toasts.value.push({ ...toast, id });
    release(id);
    return id;
  }

  function dismiss(id: number) {
    hold(id);
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  /** The pointer is on it, so someone is reading: a long stderr dump must not vanish mid-sentence. */
  function hold(id: number) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  /** Starts the full clock again: raised, or the pointer left it. */
  function release(id: number) {
    const toast = toasts.value.find((candidate) => candidate.id === id);
    if (!toast) return;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => dismiss(id), LINGER[toast.kind]),
    );
  }

  return { toasts: readonly(toasts), notify, dismiss, hold, release };
});
