import type { EntryType } from "@loadout/core";
import { defineStore } from "pinia";
import { ref } from "vue";
import type { ListFilter } from "../catalog.ts";

/** What the list is narrowed to, kept while another view is open so coming back finds it as it was. */
export const useListStore = defineStore("list", () => {
  const type = ref<EntryType | null>(null);
  const from = ref<string | null>(null);
  const state = ref<ListFilter["state"]>("any");
  const hideOverridden = ref(false);
  const query = ref("");
  return { type, from, state, hideOverridden, query };
});
