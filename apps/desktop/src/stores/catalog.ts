import type { CatalogRow, EntryRecord, Result } from "@loadout/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "./activity.ts";
import { useViewStore } from "./views.ts";

/**
 * The catalogs and every copy they hold, as the last load read them. Only launch and Refresh pull; every
 * other load reads the clones on disk, so a write's reload stays local.
 */
export const useCatalogStore = defineStore("catalog", () => {
  const library = useLibrary();
  const activity = useActivityStore();
  const views = useViewStore();

  const entries = ref<EntryRecord[]>([]);
  const catalogs = ref<CatalogRow[]>([]);
  // True from the start: the app loads on mount, and false would flash an empty catalog first.
  const loading = ref(true);
  /** why the last load failed, verbatim */
  const failure = ref<string | null>(null);
  const lastPulled = ref<Date | null>(null);
  /** what the last pull said about individual catalogs (one skipped or offline doesn't fail the rest) */
  const pullWarnings = ref<string[]>([]);
  /** the last launch found no catalog registered, so the app has to be set up before it can list anything */
  const unregistered = ref(false);

  const firstLoad = computed(() => loading.value && entries.value.length === 0);

  /** A list the app can no longer read would describe a state it can't vouch for, so it goes too. */
  function fail(message: string) {
    failure.value = message;
    entries.value = [];
    catalogs.value = [];
  }

  async function read(): Promise<boolean> {
    const [listed, rows] = await Promise.all([library.list(), library.catalogs()]);
    if (!listed.ok) {
      fail(listed.error.message);
      return false;
    }
    if (!rows.ok) {
      fail(rows.error.message);
      return false;
    }
    entries.value = listed.value;
    catalogs.value = rows.value;
    views.prune(new Set(listed.value.map((e) => e.name)));
    return true;
  }

  async function pulled(result: Result<unknown>) {
    if (!result.ok) return fail(result.error.message);
    pullWarnings.value = [...new Set(result.warnings.map((w) => w.message))];
    if (await read()) lastPulled.value = new Date();
  }

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    loading.value = true;
    failure.value = null;
    try {
      await activity.withActivity(label, work);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      loading.value = false;
    }
  }

  /** When the app opens, and again once first run registers something: sweep, load the config, pull every catalog, then read. */
  const launch = () =>
    run("refreshing the catalog…", async (signal) => {
      const launched = await library.launch({ signal });
      unregistered.value = launched.ok && launched.value.state === "no-catalogs";
      await pulled(launched);
    });
  /** Refresh: the user asked for fresh, so pull first. */
  const refresh = () => run("refreshing the catalog…", async () => pulled(await library.refresh()));
  /** After a write: read what is on disk now. */
  const reload = () => run("reading the catalog…", async () => void (await read()));

  return { entries, catalogs, loading, failure, lastPulled, pullWarnings, unregistered, firstLoad, launch, refresh, reload };
});
