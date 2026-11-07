<script setup lang="ts">
import type { Library, LoadoutRecord } from "@loadout/core";
import { computed, onMounted, ref } from "vue";
import { loadoutSummary, needsSync, savedOutcome } from "../loadouts.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useToastStore } from "../stores/toasts.ts";
import { useViewStore } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import LoadoutEditor from "./LoadoutEditor.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";

type Saved = Extract<Awaited<ReturnType<Library["applySaveLoadout"]>>, { ok: true }>["value"];
type Outcome = { kind: "success" | "warning" | "error"; message: string; detail?: string };

const NEW = "";

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

const edited = computed(() => loadouts.value.find((l) => l.name === editing.value) ?? null);

/** `checkRemote` asks each remote source whether it moved, which takes the network. */
async function load(checkRemote = false) {
  loading.value = true;
  const label = checkRemote ? "checking each loadout's sources…" : "reading loadouts…";
  const listed = await activity.withActivity(label, () => library.loadouts({ checkRemote }));
  loading.value = false;
  if (!listed.ok) {
    failure.value = listed.error.message;
    return;
  }
  failure.value = null;
  loadouts.value = listed.value;
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

/** Straight from the click, with no await before it, so WebKit treats the write as the user's own. */
function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toasts.notify({ kind: "success", message: "Copied", detail: text }),
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
      @back="views.loadouts = false"
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
        ~/.claude. Start a session with its command; two loadouts can run side by side.
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
        :key="editing"
        :loadout="edited"
        :taken="loadouts.map((l) => l.name)"
        @saved="saved"
        @cancel="editing = null"
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
            <span class="loadouts__summary">{{ loadoutSummary(l) }}</span>
          </div>
          <p
            v-if="needsSync(l)"
            class="loadouts__stale"
          >
            Some members aren't up to date with their catalogs, or aren't built yet.
            <button
              type="button"
              class="btn-xs"
              @click="views.sync = true"
            >
              Sync
            </button>
          </p>
          <code class="loadouts__run">{{ l.run }}</code>
          <div class="loadouts__actions">
            <button
              type="button"
              class="ghost btn-sm"
              @click="copy(l.run)"
            >
              Copy loadout run
            </button>
            <button
              type="button"
              class="ghost btn-sm"
              title="For a .dmg install without the loadout command"
              @click="copy(l.command)"
            >
              Copy command for a .dmg install
            </button>
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
.loadouts__head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}
.loadouts__name {
  margin: 0;
  font-size: 1rem;
}
.loadouts__summary {
  font-size: 0.8rem;
  opacity: 0.75;
}
.loadouts__stale {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: var(--status-attention-ink);
}
.loadouts__run {
  display: inline-block;
  margin: 0.6rem 0;
  font-size: 0.8rem;
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
