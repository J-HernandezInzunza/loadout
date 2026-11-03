<script setup lang="ts">
import type { ScanItem } from "@loadout/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";
import { SESSION_TIMING, unloadableReason, unmanagedOrigin } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useListStore } from "../stores/list.ts";
import { useToastStore } from "../stores/toasts.ts";
import { useViewStore } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import StatusBanner from "./StatusBanner.vue";

const GROUPS = [
  { type: "skill", label: "Skills" },
  { type: "prompt", label: "Prompts" },
  { type: "agent", label: "Agents" },
] as const;

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const toasts = useToastStore();
const views = useViewStore();
const { unmanaged, scanFailure, entries, firstLoad, loading } = storeToRefs(catalog);
const { query } = storeToRefs(useListStore());

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? unmanaged.value.filter((i) => i.name.toLowerCase().includes(q)) : unmanaged.value;
});
const groups = computed(() => GROUPS.map((g) => ({ ...g, items: shown.value.filter((i) => i.type === g.type) })).filter((g) => g.items.length));

/** The catalog copy installing this name would fetch, which asks before replacing what is there. */
const catalogCopy = (item: ScanItem) => (item.inCatalog ? entries.value.find((e) => e.type === item.type && e.name === item.name && e.overriddenBy === null) : undefined);

/**
 * A skill or a single-file prompt, which skillOverrides keys by name; not a namespace folder, not one Claude
 * Code can't load, not one set to a value Loadout leaves alone. Agents aren't toggled (Q15 A).
 */
const switchable = (item: ScanItem) =>
  item.loadable && item.skillOverride === null && (item.type === "skill" || (item.type === "prompt" && item.path.endsWith(".md")));

const toggling = ref(new Set<string>());

async function flip(item: ScanItem) {
  const on = item.disabled === true;
  toggling.value.add(item.name);
  try {
    const result = await activity.withActivity(`${on ? "enabling" : "disabling"} ${item.name}…`, () => library.setSkillState([item.name], on ? "on" : "off"));
    if (!result.ok) {
      toasts.notify({ kind: "error", message: `Could not switch ${item.name}.`, detail: result.error.message });
      return;
    }
    toasts.notify({ kind: "success", message: `${item.name} is switched ${on ? "on" : "off"}. ${SESSION_TIMING}` });
    await catalog.reload();
  } finally {
    toggling.value.delete(item.name);
  }
}

/** The item itself, a link included, not what it points at. */
async function reveal(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    toasts.notify({ kind: "error", message: `Could not show ${path}.`, detail: String(e) });
  }
}
</script>

<template>
  <BusyIndicator
    v-if="firstLoad"
    label="Reading ~/.claude…"
  />
  <StatusBanner
    v-else-if="scanFailure"
    kind="error"
    :detail="scanFailure"
  >
    Loadout couldn't read what is in ~/.claude.
  </StatusBanner>
  <p
    v-else-if="!unmanaged.length"
    class="state__line"
  >
    Everything in ~/.claude was installed by Loadout.
  </p>
  <div
    v-else-if="!shown.length"
    class="state"
  >
    <p class="state__line">
      Nothing here matches <strong>{{ query }}</strong>.
    </p>
    <button
      type="button"
      class="ghost"
      @click="query = ''"
    >
      Clear the search
    </button>
  </div>
  <div
    v-else
    class="unmanaged"
    :class="{ 'is-refreshing': loading }"
  >
    <section
      v-for="group in groups"
      :key="group.type"
      class="unmanaged__group"
    >
      <h2 class="unmanaged__label">
        {{ group.label }}
      </h2>
      <ul class="unmanaged__list">
        <li
          v-for="item in group.items"
          :key="item.path"
          class="unmanaged__item"
          :class="{ 'unmanaged__item--off': item.disabled }"
        >
          <div class="unmanaged__head">
            <button
              v-if="switchable(item)"
              type="button"
              role="switch"
              class="unmanaged__switch"
              :aria-checked="!item.disabled"
              :disabled="toggling.has(item.name)"
              :aria-label="`${item.name} enabled`"
              :title="`${item.disabled ? 'Enable' : 'Disable'} ${item.name}`"
              @click="flip(item)"
            />
            <span class="unmanaged__name">{{ item.name }}</span>
            <!-- The list's badge for the same state, with when the change lands on hover. -->
            <span
              v-if="item.disabled"
              class="unmanaged__status"
              :title="SESSION_TIMING"
            >
              disabled
            </span>
            <button
              type="button"
              class="ghost btn-xs unmanaged__reveal"
              @click="reveal(item.path)"
            >
              Reveal in Finder
            </button>
          </div>
          <p class="unmanaged__path">
            <code>{{ item.path }}</code>
          </p>
          <p class="unmanaged__origin">
            {{ unmanagedOrigin(item) }}
          </p>
          <p
            v-if="unloadableReason(item)"
            class="unmanaged__warning"
          >
            {{ unloadableReason(item) }}
          </p>
          <p
            v-if="catalogCopy(item)"
            class="unmanaged__shared"
          >
            Shares a name with {{ catalogCopy(item)!.catalog }}'s {{ item.type }}; installing it asks before replacing this.
            <button
              type="button"
              class="ghost btn-xs"
              @click="views.trail = [{ name: item.name, catalog: catalogCopy(item)!.catalog }]"
            >
              Open {{ item.name }}
            </button>
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.unmanaged {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.unmanaged__label {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.7;
}
.unmanaged__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.unmanaged__item {
  padding: 0.85rem 1rem;
  border-radius: 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
}
/* As the list's switched-off cards: on the machine, but nothing is loading it. */
.unmanaged__item--off {
  border-style: dashed;
}
.unmanaged__item--off .unmanaged__name,
.unmanaged__item--off .unmanaged__origin {
  opacity: 0.55;
}
.unmanaged__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.unmanaged__name {
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.unmanaged__status {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  white-space: nowrap;
  background: var(--status-disabled-tint);
  color: var(--status-disabled-ink);
}
.unmanaged__reveal {
  margin-left: auto;
}
.unmanaged__path,
.unmanaged__origin,
.unmanaged__warning,
.unmanaged__shared {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  line-height: 1.4;
}
.unmanaged__path {
  font-size: 0.78rem;
  opacity: 0.6;
  overflow-wrap: anywhere;
}
.unmanaged__warning {
  color: var(--status-attention-ink);
  font-weight: 600;
}
.unmanaged__shared {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  opacity: 0.85;
}
/* EntryList's switch: the same control for the same setting. */
.unmanaged__switch {
  position: relative;
  flex: none;
  width: 1.9rem;
  height: 1.05rem;
  padding: 0;
  border: 1px solid var(--control-off);
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}
.unmanaged__switch::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 0.1rem;
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  background: var(--control-off);
  transform: translateY(-50%);
  transition: transform 0.12s ease;
}
.unmanaged__switch[aria-checked="true"] {
  background: var(--control-on);
  border-color: var(--control-on);
}
.unmanaged__switch[aria-checked="true"]::after {
  background: var(--control-on-knob);
  transform: translate(0.8rem, -50%);
}
.unmanaged__switch:hover:not(:disabled) {
  border-color: var(--control-on);
}
.unmanaged__switch:disabled {
  opacity: 0.7;
  cursor: progress;
}
</style>
