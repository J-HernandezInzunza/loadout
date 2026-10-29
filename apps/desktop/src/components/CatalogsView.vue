<script setup lang="ts">
import type { CatalogRow, Library } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { catalogHue, describeCatalog } from "../catalog.ts";
import type { WriteLanding as Landing } from "../catalogWrite.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import EntryEditor from "./EntryEditor.vue";
import EntryRemove from "./EntryRemove.vue";
import PageHeader from "./PageHeader.vue";
import RegisterCatalog, { type RegisterMode } from "./RegisterCatalog.vue";
import StatusBanner from "./StatusBanner.vue";
import WriteLanding from "./WriteLanding.vue";

type Pin = Extract<Awaited<ReturnType<Library["pins"]>>, { ok: true }>["value"][number];
type Removed = Extract<Awaited<ReturnType<Library["removeCatalog"]>>, { ok: true }>["value"] & { id: string; askedToPurge: boolean; cloneKeptAt: string | null };

const props = defineProps<{
  /** the catalog whose entries are open, or null for the registry */
  at: string | null;
  /** the title of the page this view was opened from */
  back: string;
}>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const { catalogs, entries } = storeToRefs(catalog);
const views = useViewStore();

/** Opened straight at a catalog (from the list or an entry), so Back leaves rather than climbing to the registry. */
const arrivedAtCatalog = ref(props.at !== null);
const registerAs = ref<RegisterMode | null>(null);

const open = computed(() => catalogs.value.find((c) => c.id === props.at) ?? null);
const editable = (c: CatalogRow) => c.editable;
const nothingEditable = computed(() => !catalogs.value.some(editable));
const noOwnCatalog = computed(() => catalogs.value.length > 0 && !catalogs.value.some((c) => c.kind === "local"));
const held = computed(() => entries.value.filter((e) => e.catalog === props.at).sort((a, b) => a.name.localeCompare(b.name)));

function goTo(id: string | null) {
  arrivedAtCatalog.value = false;
  views.manage = { catalog: id, entry: null };
  failure.value = null;
  removed.value = null;
}

function leaveCatalog() {
  if (arrivedAtCatalog.value) views.manage = null;
  else goTo(null);
}

// A catalog unregistered from under its own page goes back to the registry.
watch(catalogs, () => {
  if (props.at !== null && !open.value) goTo(null);
});

// ---- a catalog's entries ----
/** One panel at a time, held as one value so two open forms aren't representable. */
type Panel = { key: string; mode: "edit" | "remove" };
const panel = ref<Panel | null>(null);
/** what the last removal did, said here because its row is gone */
const entryOutcome = ref<{ text: string; landing: Landing | null } | null>(null);
const keyOf = (e: { type: string; name: string }) => `${e.type}:${e.name}`;

function show(key: string, mode: Panel["mode"]) {
  const open = panel.value;
  panel.value = open?.key === key && open.mode === mode ? null : { key, mode };
  entryOutcome.value = null;
}
const isOpen = (key: string, mode: Panel["mode"]) => panel.value?.key === key && panel.value.mode === mode;

function afterRemove(text: string, landing: Landing | null) {
  panel.value = null;
  entryOutcome.value = { text, landing };
}

// Arriving from an entry page lands on that entry's edit form, scrolled into view.
watch(
  () => views.manage?.entry,
  async (name) => {
    const entry = held.value.find((e) => e.name === name);
    if (!entry) return;
    panel.value = { key: keyOf(entry), mode: "edit" };
    await nextTick();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(`entry-${entry.name}`)?.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: "center" });
  },
  { immediate: true },
);

// ---- pins ----
const pins = ref<Pin[]>([]);
const pinFailure = ref<string | null>(null);
const clearing = ref("");

async function loadPins() {
  const listed = await library.pins();
  if (listed.ok) pins.value = listed.value;
  else pinFailure.value = listed.error.message;
}

async function clearPin(name: string) {
  clearing.value = name;
  pinFailure.value = null;
  const done = await activity.withActivity(`unpinning ${name}…`, () => library.unpin(name));
  clearing.value = "";
  if (!done.ok) {
    pinFailure.value = done.error.message;
    return;
  }
  await Promise.all([loadPins(), catalog.reload()]);
}

onMounted(loadPins);
watch(catalogs, loadPins);

// ---- unregister ----
const unregistering = ref<CatalogRow | null>(null);
const purgeClone = ref(false);
const purgeInstalls = ref(false);
/** guards the confirm against a second click while the first is still running */
const removing = ref(false);
const failure = ref<string | null>(null);
const removed = ref<Removed | null>(null);
const installedFrom = computed(() => entries.value.filter((e) => e.catalog === unregistering.value?.id && e.installed).length);

function askUnregister(target: CatalogRow) {
  unregistering.value = target;
  purgeClone.value = false;
  purgeInstalls.value = false;
}

async function unregister() {
  const target = unregistering.value;
  if (!target || removing.value) return;
  removing.value = true;
  failure.value = null;
  const asked = { purgeClone: purgeClone.value, purgeInstalls: purgeInstalls.value };
  const done = await activity.withActivity(`unregistering ${target.id}…`, () => library.removeCatalog({ id: target.id, ...asked }));
  removing.value = false;
  if (!done.ok) {
    failure.value = done.error.message;
    return;
  }
  removed.value = { ...done.value, id: target.id, askedToPurge: asked.purgeInstalls, cloneKeptAt: target.kind === "remote" && !done.value.purgedClone ? target.location : null };
  unregistering.value = null;
  await catalog.reload();
}
</script>

<template>
  <section class="view">
    <!-- Its own level, so registering is a focused page with a way back rather than a panel over the list. -->
    <PageHeader
      v-if="registerAs"
      title="Add a catalog"
      back="Catalogs"
      @back="registerAs = null"
    >
      <RegisterCatalog
        :catalogs="catalogs"
        :start="registerAs"
        @registered="catalog.reload()"
        @close="registerAs = null"
      />
    </PageHeader>

    <!-- Level 1: the registry. -->
    <PageHeader
      v-else-if="at === null"
      title="Catalogs"
      :back="back"
      @back="views.manage = null"
    >
      <template #actions>
        <button
          type="button"
          class="ghost"
          @click="registerAs = 'existing'"
        >
          Add a catalog
        </button>
        <button
          type="button"
          class="ghost"
          @click="views.doctor = true"
        >
          Check catalog health
        </button>
      </template>

      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      />
      <StatusBanner
        v-else-if="removed"
        kind="success"
      >
        <p class="catalogs__done">
          Unregistered {{ removed.id }}.
          <template v-if="removed.purgedInstalls.length">
            Deleted {{ removed.purgedInstalls.length }} installed {{ removed.purgedInstalls.length === 1 ? "copy" : "copies" }}. The
            catalog's own entries stay in its file.
          </template>
          <template v-else-if="removed.askedToPurge">
            <strong>No copies were deleted.</strong> None of the installs on this machine record having come from
            {{ removed.id }}, so nothing was attributable to it.
          </template>
          <template v-else>
            Its entries and every file installed from them are untouched.
          </template>
          <template v-if="removed.purgedClone">
            Its clone was deleted.
          </template>
          <template v-else-if="removed.cloneKeptAt">
            Its clone of {{ removed.cloneKeptAt }} is still on this machine.
          </template>
        </p>
        <ul
          v-if="removed.purgedInstalls.length"
          class="catalogs__deleted"
        >
          <li
            v-for="path in removed.purgedInstalls"
            :key="path"
          >
            <code>{{ path }}</code>
          </li>
        </ul>
        <p
          v-if="removed.clearedReceipts"
          class="catalogs__done-detail"
        >
          Also cleared {{ removed.clearedReceipts }} stale {{ removed.clearedReceipts === 1 ? "receipt" : "receipts" }} for
          copies that were already gone.
        </p>
      </StatusBanner>

      <!-- Derived from the registry, so registering one is what takes it away; nothing can leave it wrongly hidden. -->
      <section
        v-if="noOwnCatalog"
        class="catalogs__own card"
      >
        <h3 class="catalogs__own-title">
          You don't have a personal catalog yet
        </h3>
        <p class="catalogs__own-lead">
          Every catalog below lives in a git repository, where a change lands for everyone who reads it. A
          <strong>personal catalog</strong> is a second one, kept on this machine and checked first, holding entries only
          you see.
        </p>
        <ul class="catalogs__own-why">
          <li>Add your own skills, agents, and prompts without opening a pull request.</li>
          <li>
            Keep your own version of a shared entry: added under the same name, your copy is the one that installs and
            the shared one stays where it is.
          </li>
          <li>It is a plain <code>library.yaml</code> on this machine. Nothing in it is shared until you decide to share it.</li>
        </ul>
        <button
          type="button"
          @click="registerAs = 'create'"
        >
          Create a personal catalog
        </button>
      </section>
      <p
        v-else-if="nothingEditable"
        class="catalogs__lead"
      >
        None of these is a catalog you can edit from here: each is read-only or was not loaded, and each row below says
        which. <strong>Check catalog health</strong> above is where that gets diagnosed.
      </p>
      <p class="catalogs__lead">
        Where your entries come from, in precedence order: when two catalogs define the same name, the one nearer the top
        is the copy that installs.
      </p>

      <!-- Below the order it overrides, because it reads as nonsense before it. -->
      <section
        v-if="pins.length"
        class="catalogs__pins"
      >
        <h3 class="catalogs__pins-title">
          Pinned names ({{ pins.length }})
        </h3>
        <p class="catalogs__lead">
          These ignore the order above and come from the catalog named here. Set one from an entry's own page, under
          <strong>Where this comes from</strong>.
        </p>
        <StatusBanner
          v-if="pinFailure"
          kind="error"
          :detail="pinFailure"
        />
        <ul class="catalogs__pin-list">
          <li
            v-for="pin in pins"
            :key="pin.name"
            class="catalogs__pin"
          >
            <span class="catalogs__pin-name">{{ pin.name }}</span>
            <span class="catalogs__pin-arrow">→</span>
            <span class="catalogs__chip catalogs__pin-chip">{{ pin.catalog }}</span>
            <!-- The silent failure this block exists for: the name still installs, just not from there. -->
            <span
              v-if="pin.dangling"
              class="catalogs__pin-dangling"
            >
              {{ pin.catalog }} can't supply this
              {{ pin.resolvesTo ? `— it comes from ${pin.resolvesTo} instead` : "— and no catalog defines the name" }}
            </span>
            <button
              type="button"
              class="ghost btn-xs catalogs__pin-clear"
              :disabled="clearing === pin.name"
              @click="clearPin(pin.name)"
            >
              {{ clearing === pin.name ? "Clearing…" : "Clear" }}
            </button>
          </li>
        </ul>
      </section>

      <ul class="catalogs__list">
        <li
          v-for="option in catalogs"
          :key="option.id"
          class="catalogs__row"
          :style="{ '--catalog-hue': catalogHue(option.precedence) }"
        >
          <div class="catalogs__row-head">
            <span class="catalogs__chip">{{ option.id }}</span>
            <span class="catalogs__meta">
              {{ describeCatalog(option).what }} · {{ option.entries === null ? "entry count unknown" : `${option.entries} entries` }}
            </span>
            <button
              v-if="editable(option)"
              type="button"
              class="ghost btn-sm catalogs__manage"
              @click="goTo(option.id)"
            >
              Manage entries
            </button>
          </div>
          <p class="catalogs__where">
            {{ option.location }}
          </p>
          <p class="catalogs__why">
            {{ describeCatalog(option).note }}
          </p>
          <button
            v-if="catalogs.length > 1 && unregistering?.id !== option.id"
            type="button"
            class="danger btn-sm catalogs__unregister"
            @click="askUnregister(option)"
          >
            Unregister
          </button>
          <div
            v-if="unregistering?.id === option.id"
            class="catalogs__confirm fade-in"
          >
            <p class="catalogs__question">
              Stop reading from {{ option.id }}?
            </p>
            <p class="catalogs__note">
              Its entries stay in their catalog file and every copy installed from them stays on disk. Only this machine's
              list of catalogs changes, and registering it again brings it back.
            </p>
            <label class="catalogs__purge">
              <input
                v-model="purgeInstalls"
                type="checkbox"
              >
              <span>
                Also delete the copies installed from it{{ installedFrom ? ` — around ${installedFrom}` : "" }}. Otherwise
                they stay on disk with no catalog left to remove them through. Copies Loadout didn't install are never
                touched.
              </span>
            </label>
            <label
              v-if="option.kind !== 'local'"
              class="catalogs__purge"
            >
              <input
                v-model="purgeClone"
                type="checkbox"
              >
              <span>Also delete the clone this machine keeps of that repository.</span>
            </label>
            <div class="catalogs__confirm-actions">
              <button
                type="button"
                class="ghost"
                :disabled="removing"
                @click="unregistering = null"
              >
                Cancel
              </button>
              <button
                type="button"
                class="danger"
                :disabled="removing"
                @click="unregister()"
              >
                {{ purgeInstalls ? "Unregister and delete the copies" : "Unregister" }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </PageHeader>

    <!-- Level 2: one catalog's entries. -->
    <PageHeader
      v-else
      :title="at"
      :back="arrivedAtCatalog ? back : 'Catalogs'"
      @back="leaveCatalog()"
    >
      <template #actions>
        <button
          type="button"
          class="ghost"
          @click="views.addingTo = at"
        >
          Add an entry
        </button>
      </template>
      <StatusBanner
        v-if="entryOutcome"
        kind="success"
      >
        <p>{{ entryOutcome.text }}</p>
        <WriteLanding
          v-if="entryOutcome.landing"
          :landing="entryOutcome.landing"
        />
      </StatusBanner>
      <p class="catalogs__lead">
        {{ open?.location }}
      </p>
      <div
        v-if="!held.length"
        class="catalogs__empty"
      >
        <p class="catalogs__empty-line">
          {{ at }} has no entries yet.
        </p>
        <p class="catalogs__empty-line catalogs__first">
          <strong>Add an entry</strong> above puts the first one in.
          <template v-if="open?.precedence === 1">
            A common first move is your own version of a shared entry, added under the same name: this catalog is checked
            first, so your copy is the one that installs and the shared one stays where it is.
          </template>
        </p>
      </div>
      <ul
        v-else
        class="catalogs__entries"
      >
        <li
          v-for="entry in held"
          :id="`entry-${entry.name}`"
          :key="`${entry.type}:${entry.name}`"
          class="catalogs__entry"
          :class="{ 'catalogs__entry--open': panel?.key === keyOf(entry) }"
        >
          <div class="catalogs__entry-line">
            <span class="catalogs__entry-name">{{ entry.name }}</span>
            <span class="catalogs__entry-type">{{ entry.type }}</span>
            <span class="catalogs__entry-desc">{{ entry.description }}</span>
            <span class="catalogs__entry-actions">
              <button
                type="button"
                class="ghost btn-sm"
                :aria-expanded="isOpen(keyOf(entry), 'edit')"
                @click="show(keyOf(entry), 'edit')"
              >
                Edit
              </button>
              <button
                type="button"
                class="danger btn-sm"
                :aria-expanded="isOpen(keyOf(entry), 'remove')"
                @click="show(keyOf(entry), 'remove')"
              >
                Remove
              </button>
            </span>
          </div>
          <div
            v-if="panel?.key === keyOf(entry)"
            class="catalogs__panel fade-in"
          >
            <EntryEditor
              v-if="panel.mode === 'edit'"
              :entry="entry"
              @close="panel = null"
            />
            <EntryRemove
              v-else
              :entry="entry"
              @removed="afterRemove"
              @close="panel = null"
            />
          </div>
        </li>
      </ul>
    </PageHeader>
  </section>
</template>

<style scoped>
.catalogs__lead {
  margin: 0 0 1.1rem;
  font-size: 0.82rem;
  line-height: 1.5;
  opacity: 0.7;
  overflow-wrap: anywhere;
}
/* A card rather than another paragraph: it is the only block on the page that teaches
   something instead of reporting it, and at the lead's size and opacity it read as more of
   the boilerplate above the list — which is where it spent a release being skipped. */
.catalogs__own {
  margin-bottom: 1.4rem;
  border-left: 3px solid var(--accent-edge);
}
.catalogs__own-title {
  margin: 0 0 0.4rem;
  font-size: 0.95rem;
}
.catalogs__own-lead {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.5;
  opacity: 0.85;
}
.catalogs__own-why {
  margin: 0.5rem 0 0.8rem;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8rem;
  line-height: 1.45;
  opacity: 0.8;
}
.catalogs__own-note {
  margin: 0.5rem 0 0;
  font-size: 0.74rem;
  line-height: 1.45;
  opacity: 0.6;
}
/* The shape the app's other empty states use — centred, roomy, quiet — rather than a lead
   paragraph, so an empty catalog reads as a state and not as a page whose list failed to
   render. Its own rule and not App.vue's `.state`, which is scoped to that component. */
.catalogs__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7rem;
  padding: 2rem 0;
  text-align: center;
  opacity: 0.8;
}
.catalogs__empty-line {
  margin: 0;
}
/* A measure on the follow-through only: centred running text past this width stops being
   readable as a sentence, and the line above it is short enough not to care. */
.catalogs__first {
  max-width: 34rem;
  font-size: 0.85rem;
  line-height: 1.5;
}
.catalogs__list,
.catalogs__entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.catalogs__pins {
  margin-bottom: 1.4rem;
}
.catalogs__pins-title {
  margin: 0 0 0.4rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
}
.catalogs__pin-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.catalogs__pin {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.45rem 0.9rem;
  border-radius: 8px;
  background: var(--surface-raised);
}
.catalogs__pin-name {
  font-size: 0.85rem;
  font-weight: 600;
}
.catalogs__pin-arrow {
  opacity: 0.4;
}
.catalogs__pin-chip {
  background: var(--surface-strong);
  color: inherit;
}
.catalogs__pin-dangling {
  flex: 1;
  font-size: 0.74rem;
  line-height: 1.4;
  color: var(--status-attention-ink);
}
.catalogs__pin-clear {
  margin-left: auto;
}
.catalogs__row {
  padding: 0.7rem 0.9rem;
  border-radius: 8px;
  border-left: 3px solid var(--catalog-edge);
  background: var(--surface-raised);
}
.catalogs__row-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.catalogs__chip {
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: var(--catalog-fill);
  color: var(--text-on-accent);
  font-size: 0.7rem;
  font-weight: 600;
}
.catalogs__meta {
  flex: 1;
  font-size: 0.75rem;
  opacity: 0.7;
}
.catalogs__where {
  margin: 0.35rem 0 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.72rem;
  opacity: 0.55;
  overflow-wrap: anywhere;
}
.catalogs__why {
  margin: 0.35rem 0 0;
  font-size: 0.74rem;
  line-height: 1.45;
  opacity: 0.65;
}
.catalogs__unregister {
  margin-top: 0.5rem;
}
.catalogs__confirm {
  margin-top: 0.6rem;
  padding: 0.7rem;
  border-radius: 8px;
  background: var(--status-danger-tint);
  border-left: 3px solid var(--status-danger-ink);
}
.catalogs__question {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
}
.catalogs__note {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  line-height: 1.45;
  opacity: 0.8;
}
.catalogs__purge {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin-top: 0.5rem;
  font-size: 0.76rem;
  line-height: 1.45;
}
.catalogs__confirm-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.6rem;
}
.catalogs__done {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.45;
}
.catalogs__done-detail {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  opacity: 0.8;
}
.catalogs__deleted {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  max-height: 10rem;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.72rem;
  opacity: 0.8;
  overflow-wrap: anywhere;
}
.catalogs__entry {
  border-radius: 8px;
  background: var(--surface-raised);
}
.catalogs__entry--open {
  background: var(--surface-hover);
}
.catalogs__entry-line {
  display: grid;
  grid-template-columns: minmax(8rem, auto) auto 1fr auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.6rem 0.4rem 0.85rem;
}
.catalogs__entry-name {
  font-size: 0.88rem;
  font-weight: 600;
}
.catalogs__entry-type {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.55;
}
.catalogs__entry-desc {
  font-size: 0.78rem;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catalogs__entry-actions {
  display: flex;
  gap: 0.5rem;
}
/* Pressed state, so an open form's own button reads as the thing that opened it. */
.catalogs__entry-actions button[aria-pressed="true"] {
  background: var(--surface-strong);
}
.catalogs__panel {
  padding: 0.2rem 0.85rem 0.85rem;
}
</style>
