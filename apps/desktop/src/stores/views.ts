import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** An entry page: a name with the catalog whose copy it shows, since a name has a copy per catalog. */
export interface EntryStop {
  name: string;
  catalog: string;
}

export type View =
  | { kind: "doctor" }
  | { kind: "sync" }
  | { kind: "add"; catalog: string }
  | { kind: "catalogs"; catalog: string | null; entry: string | null }
  | { kind: "install"; name: string }
  | { kind: "entry"; stop: EntryStop; back: EntryStop | null }
  | { kind: "list" };

/**
 * Which one view is on screen. Each is held separately and the current one is the first open in priority
 * order, so closing a view opened from another falls back to it with nothing to restore.
 */
export const useViewStore = defineStore("views", () => {
  const doctor = ref(false);
  const sync = ref(false);
  const addingTo = ref<string | null>(null);
  const manage = ref<{ catalog: string | null; entry: string | null } | null>(null);
  const installFor = ref<string | null>(null);
  /** entry pages opened, most recent last, so Back walks a dependency chain back the way it came */
  const trail = ref<EntryStop[]>([]);

  const current = computed<View>(() => {
    if (doctor.value) return { kind: "doctor" };
    if (sync.value) return { kind: "sync" };
    if (addingTo.value !== null) return { kind: "add", catalog: addingTo.value };
    if (manage.value) return { kind: "catalogs", ...manage.value };
    if (installFor.value !== null) return { kind: "install", name: installFor.value };
    const stop = trail.value.at(-1);
    if (stop) return { kind: "entry", stop, back: trail.value.at(-2) ?? null };
    return { kind: "list" };
  });

  /**
   * Drops pages about names the catalogs no longer hold, after a successful load: a removed entry's page
   * would otherwise fail its next read. By name, since another catalog's copy can still answer it.
   */
  function prune(names: Set<string>) {
    trail.value = trail.value.filter((stop) => names.has(stop.name));
    if (installFor.value !== null && !names.has(installFor.value)) installFor.value = null;
  }

  /** Closes every view, back to the catalog list. */
  function home() {
    doctor.value = false;
    sync.value = false;
    addingTo.value = null;
    manage.value = null;
    installFor.value = null;
    trail.value = [];
  }

  return { doctor, sync, addingTo, manage, installFor, trail, current, prune, home };
});
