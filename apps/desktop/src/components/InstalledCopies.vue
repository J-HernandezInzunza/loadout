<script setup lang="ts">
import type { EntryRecord } from "@loadout/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { computed, ref, watch } from "vue";
import type { PushOutcome } from "../catalog.ts";
import PushControl from "./PushControl.vue";
import StatusBanner from "./StatusBanner.vue";
import UninstallControl from "./UninstallControl.vue";

const props = defineProps<{
  /** the page's entry with the install fields of its destination */
  entry: EntryRecord;
  /** installed entries that depend on this one */
  affected: string[];
}>();
const emit = defineEmits<{ changed: [] }>();

/** One panel at a time, held as one value so two open forms aren't representable. */
type Panel = { dest: string; mode: "push" | "remove" };
const panel = ref<Panel | null>(null);
/**
 * How the last action ended. Held here rather than in the control, which closes as the page reloads:
 * a success banner inside it would vanish before anyone read it.
 */
const outcome = ref<{ kind: "success" | "error"; text: string; detail?: string; push?: PushOutcome } | null>(null);

function show(dest: string, mode: Panel["mode"]) {
  const open = panel.value;
  panel.value = open?.dest === dest && open.mode === mode ? null : { dest, mode };
  if (panel.value) outcome.value = null;
}

const isOpen = (dest: string, mode: Panel["mode"]) => panel.value?.dest === dest && panel.value.mode === mode;

function done(result: NonNullable<typeof outcome.value>) {
  outcome.value = result;
  panel.value = null;
  if (result.kind === "success") emit("changed");
}

/** The PR or compare link, in the real browser rather than the app's WebView. */
async function follow(url: string) {
  try {
    await openUrl(url);
  } catch (e) {
    outcome.value = { kind: "error", text: `Could not open ${url}.`, detail: String(e) };
  }
}

watch(
  [() => props.entry.name, () => props.entry.catalog],
  () => {
    panel.value = null;
    outcome.value = null;
  },
);

/**
 * What sits at the entry's destination: Loadout installs globally, so there is at most one. The receipt
 * says which catalog's copy it is, the one fact that tells two catalogs' copies apart once on disk.
 */
const copies = computed(() =>
  props.entry.locations.map((dest) => ({
    dest,
    fromCatalog: props.entry.receipt?.catalog.id ?? null,
    managed: props.entry.receipt !== null,
  })),
);
</script>

<template>
  <section class="copies">
    <h3 class="copies__heading">
      On this machine ({{ copies.length }})
    </h3>

    <!-- At the top of the surface that owns the command, never under the control that was pressed. -->
    <StatusBanner
      v-if="outcome"
      :kind="outcome.kind"
      :detail="outcome.detail"
    >
      <p class="copies__outcome">
        {{ outcome.text }}
      </p>
      <template v-if="outcome.push">
        <p
          v-if="outcome.push.detail"
          class="copies__outcome-detail"
        >
          {{ outcome.push.detail }}
        </p>
        <p
          v-if="outcome.push.link"
          class="copies__outcome-detail"
        >
          <button
            type="button"
            class="btn-sm"
            @click="follow(outcome.push.link.url)"
          >
            {{ outcome.push.link.label }}
          </button>
        </p>
      </template>
    </StatusBanner>

    <p
      v-if="!copies.length"
      class="copies__none"
    >
      Not installed anywhere yet. Installing puts a copy in your Claude directory; the catalog entry above
      is only a pointer to where it comes from.
    </p>

    <ul
      v-else
      class="copies__list"
    >
      <li
        v-for="copy in copies"
        :key="copy.dest"
        class="copies__item"
      >
        <div class="copies__line">
          <code class="copies__dest">{{ copy.dest }}</code>
          <span
            v-if="!copy.managed"
            class="copies__unmanaged"
          >
            Loadout didn't install this copy, so it has no record of what it holds
          </span>
          <!-- Silent when they agree, the common case. -->
          <span
            v-else-if="copy.fromCatalog !== entry.catalog"
            class="copies__foreign"
          >
            from {{ copy.fromCatalog }}, not {{ entry.catalog }}
          </span>
          <span class="copies__actions">
            <button
              type="button"
              class="ghost btn-sm"
              :aria-expanded="isOpen(copy.dest, 'push')"
              @click="show(copy.dest, 'push')"
            >
              Send edits back
            </button>
            <button
              type="button"
              class="danger btn-sm"
              :aria-expanded="isOpen(copy.dest, 'remove')"
              @click="show(copy.dest, 'remove')"
            >
              Remove
            </button>
          </span>
        </div>
        <div
          v-if="panel?.dest === copy.dest"
          class="copies__panel fade-in"
        >
          <PushControl
            v-if="panel.mode === 'push'"
            :entry="entry"
            :dest="copy.dest"
            @done="done"
            @close="panel = null"
          />
          <UninstallControl
            v-else
            :entry="entry"
            :dest="copy.dest"
            :affected="affected"
            @done="done"
            @close="panel = null"
          />
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.copies__heading {
  margin: 1.5rem 0 0.5rem;
  font-size: 0.95rem;
}
.copies__none {
  margin: 0;
  font-size: 0.88rem;
  opacity: 0.75;
}
.copies__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.copies__item {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  background: var(--surface-raised);
}
.copies__line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.copies__dest {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.copies__actions {
  display: flex;
  gap: 0.4rem;
  margin-left: auto;
}
.copies__panel {
  margin-top: 0.75rem;
}
.copies__outcome,
.copies__outcome-detail {
  margin: 0;
}
.copies__outcome-detail {
  margin-top: 0.4rem;
}
.copies__unmanaged,
.copies__foreign {
  font-size: 0.75rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--status-attention-tint);
  color: var(--status-attention-ink);
}
</style>
