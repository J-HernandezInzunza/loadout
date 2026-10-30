<script setup lang="ts">
import type { AccountHost, EntryType } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, onMounted } from "vue";
import { useAppVersion } from "../appVersion.ts";
import { HOST_NAMES, useAccountStore } from "../stores/accounts.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useListStore } from "../stores/list.ts";
import { useViewStore } from "../stores/views.ts";
import AppearanceToggle from "./AppearanceToggle.vue";

const BROWSE: { type: EntryType | null; label: string }[] = [
  { type: null, label: "All" },
  { type: "skill", label: "Skills" },
  { type: "prompt", label: "Prompts" },
  { type: "agent", label: "Agents" },
];
const HOSTS: AccountHost[] = ["github", "bitbucket"];

const { entries } = storeToRefs(useCatalogStore());
const { type } = storeToRefs(useListStore());
const views = useViewStore();
const accounts = useAccountStore();
const version = useAppVersion();

/** names, not copies: what would install, across every catalog */
const counts = computed(() => {
  const winners = entries.value.filter((e) => e.overriddenBy === null);
  return new Map(BROWSE.map((item) => [item.type, winners.filter((e) => item.type === null || e.type === item.type).length]));
});

onMounted(() => accounts.load());
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__brand">
      <span class="sidebar__name">Loadout</span>
      <AppearanceToggle />
    </div>

    <nav
      class="sidebar__group"
      aria-labelledby="sidebar-browse"
    >
      <p
        id="sidebar-browse"
        class="sidebar__label"
      >
        Browse
      </p>
      <button
        v-for="item in BROWSE"
        :key="item.label"
        type="button"
        class="sidebar__item"
        :class="{ 'sidebar__item--on': type === item.type }"
        :aria-pressed="type === item.type"
        @click="type = item.type"
      >
        <span class="sidebar__text">{{ item.label }}</span>
        <span class="sidebar__count">{{ counts.get(item.type) }}</span>
      </button>
    </nav>

    <div
      class="sidebar__group"
      role="group"
      aria-labelledby="sidebar-manage"
    >
      <p
        id="sidebar-manage"
        class="sidebar__label"
      >
        Manage
      </p>
      <button
        type="button"
        class="sidebar__item"
        @click="views.sync = true"
      >
        <span class="sidebar__text">Sync</span>
      </button>
      <button
        type="button"
        class="sidebar__item"
        @click="views.manage = { catalog: null, entry: null }"
      >
        <span class="sidebar__text">Catalogs</span>
      </button>
    </div>

    <div
      class="sidebar__group sidebar__accounts"
      role="group"
      aria-labelledby="sidebar-accounts"
    >
      <p
        id="sidebar-accounts"
        class="sidebar__label"
      >
        Accounts
      </p>
      <button
        v-for="on in HOSTS"
        :key="on"
        type="button"
        class="sidebar__item"
        @click="views.accounts = true"
      >
        <span class="sidebar__host">{{ HOST_NAMES[on] }}</span>
        <span
          class="sidebar__login"
          :class="{ 'sidebar__connect': !accounts.accounts[on] }"
          :title="accounts.accounts[on]?.login"
        >{{ accounts.accounts[on]?.login ?? "Connect" }}</span>
      </button>
    </div>

    <p
      v-if="version"
      class="sidebar__version"
    >
      Version {{ version }}
    </p>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  min-height: 0;
  overflow-y: auto;
  padding: 0.85rem 0.6rem 0.75rem;
  border-right: 1px solid var(--border-subtle);
  background: var(--surface-recessed);
}
.sidebar__brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 0.5rem;
}
.sidebar__name {
  font-size: 1.05rem;
  font-weight: 700;
}
.sidebar__group {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.sidebar__label {
  margin: 0;
  padding: 0 0.5rem 0.3rem;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
}
.sidebar__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
}
.sidebar__item:hover {
  background: var(--surface-hover);
}
.sidebar__item--on {
  background: var(--accent-tint);
  color: var(--accent-ink);
  font-weight: 600;
}
.sidebar__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar__count {
  font-size: 0.75rem;
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
}
/* The host always reads in full; a long login gives way instead, with its whole value in the tooltip. */
.sidebar__host {
  flex: none;
}
.sidebar__login {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-size: 0.75rem;
  opacity: 0.65;
}
.sidebar__connect {
  color: var(--accent-ink);
  opacity: 1;
}
/* Last, at the foot: who Loadout acts as is set once and glanced at, not used while browsing. */
.sidebar__accounts {
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-subtle);
}
.sidebar__version {
  margin: -0.6rem 0 0;
  padding: 0 0.5rem;
  font-size: 0.7rem;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
</style>
