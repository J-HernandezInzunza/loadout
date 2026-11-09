<script setup lang="ts">
import type { Library, LoadoutRecord } from "@loadout/core";
import { computed, defineAsyncComponent, onMounted, ref, useTemplateRef } from "vue";
import { loadoutSummary, needsSync, savedOutcome, syncedOutcome } from "../loadouts.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useToastStore } from "../stores/toasts.ts";
import { useViewStore } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import LoadoutEditor from "./LoadoutEditor.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";
import TypeDot from "./TypeDot.vue";

const ConfirmDialog = defineAsyncComponent(() => import("./ConfirmDialog.vue"));

type Saved = Extract<Awaited<ReturnType<Library["applySaveLoadout"]>>, { ok: true }>["value"];
type Outcome = { kind: "success" | "warning" | "error"; message: string; detail?: string };

const NEW = "";
const COPIED_MS = 1500;

const library = useLibrary();
const activity = useActivityStore();
const toasts = useToastStore();
const views = useViewStore();

const loadouts = ref<LoadoutRecord[]>([]);
const loading = ref(true);
const failure = ref<string | null>(null);
const outcome = ref<Outcome | null>(null);
/** the name of the loadout in the editor, NEW for a new one, null when it's closed */
const editing = ref<string | null>(null);
const confirming = ref<string | null>(null);
const deleting = ref(false);
/** the loadout being synced from its card */
const syncing = ref<string | null>(null);
/** whether a terminal finds `loadout`, so a card offers `loadout run` rather than the bare command */
const loadoutOnPath = ref(true);
/** the loadout whose command was just copied, while its button says so */
const copied = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const edited = computed(() => loadouts.value.find((l) => l.name === editing.value) ?? null);
const editor = useTemplateRef<InstanceType<typeof LoadoutEditor>>("editor");
/** asked before a changed draft goes: what Discard does then, close the editor or leave the screen */
const discarding = ref<"close" | "leave" | null>(null);
const discardQuestion = computed(() => {
  const isNew = editing.value === NEW;
  if (isNew) return "Discard this new loadout? Nothing in it has been saved.";
  return `Discard your changes to ${editing.value}? The saved loadout stays as it was.`;
});

/** `checkRemote` asks each remote source whether it moved, which takes the network. */
async function load(checkRemote = false) {
  loading.value = true;
  const label = checkRemote ? "checking each loadout's sources…" : "reading loadouts…";
  const [listed, found] = await activity.withActivity(label, () => Promise.all([library.loadouts({ checkRemote }), library.loadoutOnPath()]));
  loading.value = false;
  // The bare command runs with or without `loadout`, so it's what a card offers when the lookup fails.
  loadoutOnPath.value = found.ok && found.value;
  if (!listed.ok) {
    failure.value = listed.error.message;
    return;
  }
  failure.value = null;
  loadouts.value = listed.value;
}

function closeEditor() {
  if (editor.value?.changed) discarding.value = "close";
  else editing.value = null;
}

function back() {
  if (editor.value?.changed) discarding.value = "leave";
  else views.loadouts = false;
}

function discard() {
  const isLeaving = discarding.value === "leave";
  discarding.value = null;
  editing.value = null;
  if (isLeaving) views.loadouts = false;
}

function open(name: string) {
  outcome.value = null;
  confirming.value = null;
  editing.value = name;
}

async function saved(result: Saved) {
  editing.value = null;
  outcome.value = savedOutcome(result);
  await load();
}

async function deleteLoadout(name: string) {
  const planned = await library.planDeleteLoadout(name);
  if (!planned.ok) return planned;
  return activity.withActivity(`deleting ${name}…`, () => library.applyDeleteLoadout(planned.value));
}

async function remove(name: string) {
  deleting.value = true;
  const deleted = await deleteLoadout(name);
  deleting.value = false;
  confirming.value = null;
  if (deleted.ok) outcome.value = { kind: "success", message: `Deleted ${name}.` };
  else outcome.value = { kind: "error", message: `Couldn't delete ${name}.`, detail: deleted.error.message };
  await load();
}

async function syncLoadout(name: string, signal: AbortSignal) {
  const planned = await library.planSync({ loadout: name, signal });
  if (!planned.ok) return planned;
  return library.applySync(planned.value, { signal });
}

/** That loadout alone, at once: its folder is Loadout's, so there are no edits of the user's to review first. */
async function syncOne(name: string) {
  outcome.value = null;
  syncing.value = name;
  const synced = await activity.withActivity(`syncing ${name}…`, (signal) => syncLoadout(name, signal));
  syncing.value = null;
  if (synced.ok) outcome.value = syncedOutcome(name, synced.value.loadouts.find((l) => l.name === name));
  else outcome.value = { kind: "error", message: `Couldn't sync ${name}.`, detail: synced.error.message };
  await load();
}

function commandOf(loadout: LoadoutRecord): string {
  return loadoutOnPath.value ? loadout.run : loadout.command;
}

function showCopied(name: string) {
  copied.value = name;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = null), COPIED_MS);
}

/** Straight from the click, with no await before it, so WebKit treats the write as the user's own. */
function copy(loadout: LoadoutRecord) {
  navigator.clipboard.writeText(commandOf(loadout)).then(
    () => showCopied(loadout.name),
    (e: unknown) => toasts.notify({ kind: "error", message: "Couldn't copy to the clipboard", detail: e instanceof Error ? e.message : String(e) }),
  );
}

onMounted(() => load());
</script>

<template>
  <section class="view">
    <PageHeader
      title="Loadouts"
      back="Loadout"
      @back="back()"
    >
      <template #actions>
        <button
          type="button"
          class="ghost"
          :disabled="loading"
          @click="load(true)"
        >
          Check sources
        </button>
        <button
          type="button"
          :disabled="editing !== null"
          @click="open(NEW)"
        >
          New loadout
        </button>
      </template>

      <p class="loadouts__lead">
        A loadout is a set of skills, agents and prompts you bring into one Claude Code session, on top of everything in
        ~/.claude. Copy its command and paste it into a terminal in your project's folder; two loadouts can run side by
        side.
      </p>
      <p
        v-if="!loadoutOnPath && loadouts.length"
        class="loadouts__hint"
      >
        No <code>loadout</code> command on your PATH, so each card copies the full <code>claude</code> command.
        Installing Loadout with Homebrew adds the short one.
      </p>

      <StatusBanner
        v-if="outcome"
        :kind="outcome.kind"
        :detail="outcome.detail"
      >
        {{ outcome.message }}
      </StatusBanner>
      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      >
        Couldn't read your loadouts.
      </StatusBanner>

      <LoadoutEditor
        v-if="editing !== null"
        ref="editor"
        :key="editing"
        :loadout="edited"
        :taken="loadouts.map((l) => l.name)"
        @saved="saved"
        @cancel="closeEditor()"
      />
      <ConfirmDialog
        v-if="discarding"
        :question="discardQuestion"
        keep="Keep editing"
        confirm="Discard"
        @keep="discarding = null"
        @confirm="discard()"
      />

      <BusyIndicator
        v-if="loading && !loadouts.length"
        label="Reading loadouts…"
      />
      <p
        v-else-if="!loadouts.length && editing === null"
        class="loadouts__empty"
      >
        No loadouts yet. Make one with New loadout, then start a session with its command.
      </p>

      <ul class="loadouts__list">
        <li
          v-for="l in loadouts"
          :key="l.name"
          class="loadouts__item card"
        >
          <div class="loadouts__head">
            <h3 class="loadouts__name">
              {{ l.name }}
            </h3>
            <span class="loadouts__summary">
              <span
                v-for="part in loadoutSummary(l)"
                :key="part.text"
                class="loadouts__part"
              >
                <TypeDot
                  v-if="part.type"
                  :type="part.type"
                />
                {{ part.text }}
              </span>
            </span>
            <div class="loadouts__manage">
              <button
                type="button"
                class="ghost btn-sm"
                :disabled="editing !== null"
                @click="open(l.name)"
              >
                Edit
              </button>
              <button
                type="button"
                class="ghost danger btn-sm"
                @click="confirming = l.name"
              >
                Delete
              </button>
            </div>
          </div>
          <div
            v-if="needsSync(l)"
            class="loadouts__stale"
          >
            <p class="loadouts__stale-text">
              Some members aren't up to date with their catalogs, or aren't built yet: Sync rebuilds them.
            </p>
            <button
              type="button"
              class="btn-sm"
              :disabled="syncing !== null"
              @click="syncOne(l.name)"
            >
              {{ syncing === l.name ? "Syncing…" : "Sync" }}
            </button>
          </div>
          <div class="loadouts__command">
            <span
              class="loadouts__prompt"
              aria-hidden="true"
            >$</span>
            <code class="loadouts__run">{{ commandOf(l) }}</code>
            <button
              type="button"
              class="ghost btn-sm"
              aria-live="polite"
              @click="copy(l)"
            >
              {{ copied === l.name ? "Copied" : "Copy" }}
            </button>
          </div>
          <div
            v-if="confirming === l.name"
            class="loadouts__confirm fade-in"
          >
            <p class="loadouts__confirm-q">
              Delete {{ l.name }}? Its folder goes too; a session already running keeps what it loaded.
            </p>
            <div class="loadouts__actions">
              <button
                type="button"
                class="ghost btn-sm"
                @click="confirming = null"
              >
                Cancel
              </button>
              <button
                type="button"
                class="danger btn-sm"
                :disabled="deleting"
                @click="remove(l.name)"
              >
                Delete {{ l.name }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </PageHeader>
  </section>
</template>

<style scoped>
.loadouts__lead {
  margin: 0 0 1rem;
  line-height: 1.5;
  opacity: 0.85;
}
.loadouts__empty {
  margin: 0;
  opacity: 0.75;
}
.loadouts__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.loadouts__item {
  margin-bottom: 1rem;
}
.loadouts__hint {
  margin: 0 0 1rem;
  font-size: 0.8rem;
  opacity: 0.75;
}
.loadouts__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem 0.75rem;
}
.loadouts__manage {
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}
.loadouts__name {
  margin: 0;
  font-size: 1rem;
}
/* Flex rows, so one gap spaces each separator, dot and count the same. */
.loadouts__summary,
.loadouts__part {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.3rem;
}
.loadouts__summary {
  font-size: 0.8rem;
  opacity: 0.75;
}
.loadouts__part + .loadouts__part::before {
  content: "·";
}
.loadouts__stale {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.75rem;
  margin-top: 0.5rem;
}
.loadouts__stale-text {
  margin: 0;
  font-size: 0.85rem;
  color: var(--status-attention-ink);
}
/* One line: a long bare command scrolls inside the field rather than widening the card. */
.loadouts__command {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  margin-top: 0.6rem;
  padding: 0.25rem 0.25rem 0.25rem 0.65rem;
  border: 1px solid var(--border-control);
  border-radius: 8px;
}
.loadouts__prompt {
  font-family: monospace;
  font-size: 0.8rem;
  opacity: 0.6;
  user-select: none;
}
.loadouts__run {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  font-size: 0.8rem;
  white-space: nowrap;
}
.loadouts__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.loadouts__confirm {
  margin-top: 0.75rem;
}
.loadouts__confirm-q {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
</style>
